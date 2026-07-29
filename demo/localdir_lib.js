/**
 * JS side of the local-directory wasmfs backend (localdir_backend.cpp).
 *
 * The async hooks run on a wasmfs proxy worker. They read file bytes straight
 * from the FileSystemDirectoryHandle the user picked, which the page stashed in
 * a dedicated IndexedDB database ("blender-localmount") — handles survive
 * structured-clone into IDB and can be read back from any worker in the origin,
 * keeping their granted permission for the session. Nothing is copied up front:
 * getSize/read pull only what Blender asks for, on demand.
 *
 * WRITES: the mount is picked read-only, and PROMOTES to read-write lazily the
 * first time Blender writes. On that first write we request 'readwrite'
 * permission on the directory handle; once granted the whole mount is writable
 * for the session. Writes go to disk via FileSystemWritableFileStream. A stream
 * is cached per file and flushed (closed) shortly after the last write — a
 * .blend save is many sequential chunks, and reopening (copying existing data)
 * per chunk would be O(n^2). getSize/read of a file with a pending stream flush
 * it first so reads observe fresh bytes.
 */
addToLibrary({
  _wasmfs_create_localdir_backend_js__deps: [
    '$wasmFS$backends',
    '_wasmfs_localdir_get_file_path',
    '_wasmfs_localdir_get_pending_key',
  ],
  _wasmfs_create_localdir_backend_js: function (backend) {
    // Each mount stores its handle under its own IDB key (the mount point) —
    // capture ours NOW; the pending-key global is reused by the next mount.
    const idbKey = UTF8ToString(__wasmfs_localdir_get_pending_key()) || 'current';
    // Lazily resolved once per backend, on this proxy worker.
    let dirHandleP = null;
    const getDir = () => {
      if (!dirHandleP) {
        dirHandleP = (async () => {
          const db = await new Promise((res, rej) => {
            const r = indexedDB.open('blender-localmount'); // no version: open current
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          const get = (key) => new Promise((res, rej) => {
            const t = db.transaction('handles').objectStore('handles').get(key);
            t.onsuccess = () => res(t.result);
            t.onerror = () => rej(t.error);
          });
          const rec = (await get(idbKey)) || (await get('current'));
          return rec ? rec.handle : null;
        })();
      }
      return dirHandleP;
    };

    // Promotion state: 'unknown' until the first write, then 'granted'/'denied'
    // for the session. requestPermission() needs main-thread TRANSIENT USER
    // ACTIVATION, which does NOT exist on this proxy worker — so we ask the
    // page (main thread) to run the prompt, over a BroadcastChannel. The page
    // still has activation for ~5s after the user's Save click. A concurrent
    // save fires many write chunks; they all await one in-flight request.
    let granted = false;
    let promoP = null;
    let lastFail = 0;
    const doPromote = async (dir) => {
      /* Fast path: handle already carries readwrite (e.g. re-mount). */
      try {
        if (dir && dir.queryPermission &&
            (await dir.queryPermission({ mode: 'readwrite' })) === 'granted') {
          return true;
        }
      } catch (e) {}
      /* Ask the main thread to prompt (it has the user activation). */
      if (typeof BroadcastChannel === 'undefined') return false;
      return await new Promise((resolve) => {
        const id = Date.now() + ':' + Math.random();
        const bc = new BroadcastChannel('localdir-perm');
        const done = (g) => { clearTimeout(to); bc.close(); resolve(!!g); };
        const to = setTimeout(() => done(false), 15000); // no answer: retry next write
        bc.onmessage = (e) => {
          if (e.data && e.data.type === 'response' && e.data.id === id) done(e.data.granted);
        };
        bc.postMessage({ type: 'request', id, mountPoint: idbKey });
      });
    };
    const ensureWritable = async (dir) => {
      if (granted) return true;
      /* Cooldown: a single save fires many write chunks. After a failed/denied
       * prompt, suppress re-prompting for 10s so one dismissal doesn't spam a
       * prompt per chunk; a later save can try again (the user may grant then). */
      if (Date.now() - lastFail < 10000) return false;
      if (!promoP) {
        promoP = doPromote(dir).then((g) => {
          promoP = null;
          if (g) { granted = true; } else { lastFail = Date.now(); }
          return g;
        });
      }
      return promoP;
    };

    // Cache resolved FileSystemFileHandles by relative path (Blender reads/writes
    // a file in many small chunks; re-navigating each time would be wasteful).
    const handleCache = new Map();
    const resolve = async (dir, path, create) => {
      if (!create && handleCache.has(path)) return handleCache.get(path);
      const parts = path.split('/').filter(Boolean);
      let d = dir;
      for (let i = 0; i < parts.length - 1; i++) {
        d = await d.getDirectoryHandle(parts[i], { create: !!create });
      }
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: !!create });
      handleCache.set(path, fh);
      return fh;
    };

    // Per-path pending writable stream + debounced flush. Closing a
    // FileSystemWritableFileStream is what actually commits to disk.
    const streams = new Map(); // path -> { stream, timer }
    const openStream = async (fh, path) => {
      let s = streams.get(path);
      if (s) {
        if (s.timer) { clearTimeout(s.timer); s.timer = null; }
        return s.stream;
      }
      const stream = await fh.createWritable({ keepExistingData: true });
      s = { stream, timer: null };
      streams.set(path, s);
      return stream;
    };
    const scheduleFlush = (path) => {
      const s = streams.get(path);
      if (!s) return;
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => { flushStream(path); }, 250);
    };
    const flushStream = async (path) => {
      const s = streams.get(path);
      if (!s) return;
      streams.delete(path);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      try { await s.stream.close(); } catch (e) {}
    };

    wasmFS$backends[backend] = {
      allocFile: async () => {},
      freeFile: async (file) => {
        // File node going away: commit any pending stream.
        try {
          const path = UTF8ToString(__wasmfs_localdir_get_file_path(file));
          if (streams.has(path)) await flushStream(path);
        } catch (e) {}
      },

      write: async (file, buffer, length, offset) => {
        if (length <= 0) return 0;
        try {
          const dir = await getDir();
          if (!dir) return -{{{ cDefs.EBADF }}};
          if (!(await ensureWritable(dir))) return -{{{ cDefs.EACCES }}};
          const path = UTF8ToString(__wasmfs_localdir_get_file_path(file));
          const fh = await resolve(dir, path, /*create=*/ true);
          const stream = await openStream(fh, path);
          // Copy out of the wasm heap: the stream write is async and the heap
          // view may be detached/reused by then.
          const data = HEAPU8.slice(buffer, buffer + length);
          await stream.write({ type: 'write', position: offset, data });
          scheduleFlush(path);
          return length;
        } catch (e) {
          return -{{{ cDefs.EIO }}};
        }
      },

      getSize: async (file) => {
        try {
          const dir = await getDir();
          if (!dir) return 0;
          const path = UTF8ToString(__wasmfs_localdir_get_file_path(file));
          if (streams.has(path)) await flushStream(path); // fresh size
          const fh = await resolve(dir, path);
          return (await fh.getFile()).size;
        } catch (e) {
          return 0;
        }
      },

      setSize: async (file, size) => {
        try {
          const dir = await getDir();
          if (!dir) return -{{{ cDefs.EBADF }}};
          if (!(await ensureWritable(dir))) return -{{{ cDefs.EACCES }}};
          const path = UTF8ToString(__wasmfs_localdir_get_file_path(file));
          const fh = await resolve(dir, path, /*create=*/ true);
          const stream = await openStream(fh, path);
          await stream.truncate(size);
          scheduleFlush(path);
          return 0;
        } catch (e) {
          return -{{{ cDefs.EIO }}};
        }
      },

      read: async (file, buffer, length, offset) => {
        if (offset < 0 || length <= 0) return 0;
        try {
          const dir = await getDir();
          if (!dir) return -{{{ cDefs.EBADF }}};
          const path = UTF8ToString(__wasmfs_localdir_get_file_path(file));
          if (streams.has(path)) await flushStream(path); // see our own writes
          const fh = await resolve(dir, path);
          const f = await fh.getFile();
          if (offset >= f.size) return 0;
          const end = Math.min(offset + length, f.size);
          const bytes = new Uint8Array(await f.slice(offset, end).arrayBuffer());
          HEAPU8.set(bytes, buffer);
          return bytes.length;
        } catch (e) {
          return -{{{ cDefs.ENOENT }}};
        }
      },
    };
  },
});
