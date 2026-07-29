// Local-directory wasmfs backend for the demo.
//
// A real, lazy (no-copy) mount of a folder the user picks on their machine via
// the File System Access API (showDirectoryPicker). Modeled directly on
// emscripten's fetch backend (system/lib/wasmfs/backends/fetch_backend.cpp):
// the directory tree lives in Wasm memory (MemoryDirectory) but each file's
// *contents* are read on demand by async JS hooks that run on a proxy worker
// (ProxiedAsyncJSBackend). The JS side (localdir_lib.js) reads bytes straight
// from the picked FileSystemDirectoryHandle — nothing is copied up front.
//
// Each file stores its path relative to the mount root; the JS read/getSize
// hooks fetch that path via _wasmfs_localdir_get_file_path and navigate the
// directory handle to the file. Read-only for now (write/setSize are refused).

#include <cstdio>
#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include "backend.h"
#include "memory_backend.h"
#include "proxied_async_js_impl_backend.h"
#include "support.h"
#include "wasmfs.h"

extern "C" {
// Implemented in localdir_lib.js (see _wasmfs_create_localdir_backend_js).
void _wasmfs_create_localdir_backend_js(wasmfs::backend_t);
}

namespace wasmfs {

class LocalDirFile : public ProxiedAsyncJSImplFile {
  std::string filePath;

public:
  LocalDirFile(const std::string& path,
               mode_t mode,
               backend_t backend,
               emscripten::ProxyWorker& proxy)
    : ProxiedAsyncJSImplFile(mode, backend, proxy), filePath(path) {}

  const std::string& getPath() const { return filePath; }
};

class LocalDirDirectory : public MemoryDirectory {
  std::string dirPath;
  emscripten::ProxyWorker& proxy;

  std::string getChildPath(const std::string& name) const {
    return dirPath + '/' + name;
  }

public:
  LocalDirDirectory(const std::string& path,
                    mode_t mode,
                    backend_t backend,
                    emscripten::ProxyWorker& proxy)
    : MemoryDirectory(mode, backend), dirPath(path), proxy(proxy) {}

  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
                                           mode_t mode) override {
    auto child =
      std::make_shared<LocalDirFile>(getChildPath(name), mode, getBackend(), proxy);
    insertChild(name, child);
    return child;
  }

  std::shared_ptr<Directory> insertDirectory(const std::string& name,
                                             mode_t mode) override {
    auto child = std::make_shared<LocalDirDirectory>(
      getChildPath(name), mode, getBackend(), proxy);
    insertChild(name, child);
    return child;
  }
};

class LocalDirBackend : public ProxiedAsyncJSBackend {
public:
  LocalDirBackend(std::function<void(backend_t)> setupOnThread)
    : ProxiedAsyncJSBackend(setupOnThread) {}

  std::shared_ptr<DataFile> createFile(mode_t mode) override {
    return std::make_shared<LocalDirFile>("", mode, this, proxy);
  }

  std::shared_ptr<Directory> createDirectory(mode_t mode) override {
    return std::make_shared<LocalDirDirectory>("", mode, this, proxy);
  }
};

extern "C" {

const char* _wasmfs_localdir_get_file_path(void* ptr) {
  auto* file = reinterpret_cast<LocalDirFile*>(ptr);
  return file ? file->getPath().data() : nullptr;
}

backend_t wasmfs_create_localdir_backend() {
  // ProxyWorker cannot be spawned from the main browser thread (see
  // thread_utils.h); wasmfs_mount_localdir runs us on a helper pthread.
  return wasmFS.addBackend(std::make_unique<LocalDirBackend>(
    [](backend_t backend) { _wasmfs_create_localdir_backend_js(backend); }));
}

} // extern "C"

} // namespace wasmfs

// ---------------------------------------------------------------------------
// Mount entry point, called via ccall from the page after the user picks a
// folder. `listing` is the enumerated tree (built in JS, no file contents
// read): one entry per line, "<D|F>\t<relative/path>". Directories and files
// are created as empty nodes; their contents load lazily on first read.
//
// The heavy lifting runs on a DETACHED helper pthread, and wasmfs_mount_localdir
// returns immediately. This is essential: ccall invokes us on the real main
// browser thread, and creating the backend spins up a proxy worker — which
// needs the main thread's event loop to stay free. Blocking here (join) would
// deadlock. The page polls wasmfs_localdir_mount_status() for completion.
// (creator.cc can join for OPFS only because it runs before the main loop.)
// ---------------------------------------------------------------------------

namespace {

// 0 = idle/in-progress, 1 = done, -1 = failed.
volatile int g_mount_status = 0;

// IndexedDB key of the directory handle for the mount being created. Each
// mount stores its handle under its own key (the mount point path) so that
// mounting a second folder does not repoint earlier backends' lazy "current"
// lookup at the wrong handle. Read by localdir_lib.js at backend-creation
// time via _wasmfs_localdir_get_pending_key (wasm memory is shared across
// threads/workers). Mounts are serialized by the page (one picker at a time).
char g_pending_key[512] = {0};

void mkdir_p(const std::string& path) {
  for (size_t i = 1; i < path.size(); i++) {
    if (path[i] == '/') {
      std::string sub = path.substr(0, i);
      mkdir(sub.c_str(), 0777); // EEXIST is fine.
    }
  }
  mkdir(path.c_str(), 0777);
}

struct MountArgs {
  std::string mountPoint;
  std::string listing;
};

void* mount_thread_fn(void* p) {
  auto* a = static_cast<MountArgs*>(p);
  int status = -1;

  wasmfs::backend_t backend = wasmfs::wasmfs_create_localdir_backend();
  // The internal wasmfs::backend_t and the public C backend_t are distinct
  // pointer types for the same object; bridge them for the public C API.
  if (backend != nullptr &&
      wasmfs_create_directory(
        a->mountPoint.c_str(), 0777, reinterpret_cast<::backend_t>(backend)) == 0) {
    const std::string& root = a->mountPoint;
    size_t pos = 0;
    while (pos < a->listing.size()) {
      size_t nl = a->listing.find('\n', pos);
      std::string line = a->listing.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
      pos = nl == std::string::npos ? a->listing.size() : nl + 1;
      if (line.size() < 3 || line[1] != '\t') {
        continue;
      }
      char kind = line[0];
      std::string full = root + "/" + line.substr(2);
      if (kind == 'D') {
        mkdir_p(full);
      } else if (kind == 'F') {
        size_t slash = full.find_last_of('/');
        if (slash != std::string::npos) {
          mkdir_p(full.substr(0, slash));
        }
        // O_CREAT without O_TRUNC: create the node without touching contents.
        // 0644 (not 0444): the mount is read-only until a write promotes it
        // (localdir_lib.js requests 'readwrite' FS-Access permission on first
        // write); the FS layer must permit write-opens for that path to run.
        int fd = open(full.c_str(), O_CREAT | O_WRONLY, 0644);
        if (fd >= 0) {
          close(fd);
        }
      }
    }
    status = 1;
  }

  delete a;
  g_mount_status = status;
  return nullptr;
}

} // namespace

extern "C" {

// Called by localdir_lib.js (on the backend's proxy worker) to learn which
// IndexedDB key holds this mount's directory handle.
EMSCRIPTEN_KEEPALIVE const char* _wasmfs_localdir_get_pending_key() {
  return g_pending_key;
}

EMSCRIPTEN_KEEPALIVE int wasmfs_mount_localdir(const char* mountPoint,
                                               const char* listing) {
  g_mount_status = 0;
  snprintf(g_pending_key, sizeof(g_pending_key), "%s", mountPoint ? mountPoint : "current");
  auto* args = new MountArgs{mountPoint ? mountPoint : "", listing ? listing : ""};
  pthread_t th;
  if (pthread_create(&th, nullptr, mount_thread_fn, args) != 0) {
    delete args;
    g_mount_status = -1;
    return -1;
  }
  pthread_detach(th);
  return 0; // spawned; poll wasmfs_localdir_mount_status() for completion
}

EMSCRIPTEN_KEEPALIVE int wasmfs_localdir_mount_status() {
  return g_mount_status;
}

} // extern "C"
