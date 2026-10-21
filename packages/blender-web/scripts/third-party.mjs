#!/usr/bin/env node
// Writes THIRD-PARTY-LICENSES.md: this build's components, the emscripten
// runtime it links, then Blender's own third-party notices verbatim.
//   node scripts/third-party.mjs   (needs ../../blender and ../../emsdk, as after ./build.sh)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../..");
const blender = join(repo, "blender");
const emscripten = join(repo, "emsdk/upstream/emscripten");
for (const dir of [blender, emscripten]) if (!existsSync(dir)) throw new Error(`${dir} missing: run ./build.sh first`);

const read = (path) => readFileSync(path, "utf8").trim();
const version = (prefix) => (readdirSync(join(repo, "deps/src")).find((d) => d.startsWith(prefix))?.slice(prefix.length) ?? "?").replace(/^R_(\d+)_(\d+)_(\d+)$/, "$1.$2.$3");
const numpy = readdirSync(join(repo, "numpy-build")).find((d) => /^numpy-\d/.test(d) && !d.endsWith(".gz"))?.slice(6) ?? "?";
const blenderLicense = read(join(blender, "release/license/license.md")).replace(/^<!--[\s\S]*?-->\s*/, "");
const details = (title, text) => `<details>\n<summary>${title}</summary>\n\n\`\`\`\n${text}\n\`\`\`\n</details>\n`;

const out = `# Third-party licenses

\`@knervous/blender-web\` is GPL-3.0-or-later. Its runtime (\`runtime/\`) is
Blender compiled to WebAssembly, and Blender as a whole is GPL-3.0-or-later.
The package's own JavaScript is under the same license. The runtime contains
the components below, each under its own license.

## This build

| component | version | license |
|---|---|---|
| [Blender](https://www.blender.org/) ([HeyPuter/blender](https://github.com/HeyPuter/blender) at \`${read(join(blender, ".git/HEAD")).startsWith("ref:") ? "HEAD" : read(join(blender, ".git/HEAD")).slice(0, 12)}\`) | 5.3 | GPL-3.0-or-later (binary), GPL-2.0-or-later (sources) |
| [CPython](https://www.python.org/) | ${version("Python-")} | PSF-2.0 |
| [NumPy](https://numpy.org/) | ${numpy} | BSD-3-Clause (and bundled components) |
| [oneTBB](https://github.com/uxlfoundation/oneTBB) | ${version("oneTBB-")} | Apache-2.0 |
| [OpenColorIO](https://opencolorio.org/) | ${version("OpenColorIO-")} | BSD-3-Clause |
| [OpenImageIO](https://github.com/AcademySoftwareFoundation/OpenImageIO) | ${version("OpenImageIO-")} | Apache-2.0 |
| [OpenEXR](https://openexr.com/) / [Imath](https://github.com/AcademySoftwareFoundation/Imath) | ${version("openexr-")} / ${version("Imath-")} | BSD-3-Clause |
| [OpenJPH](https://github.com/aous72/OpenJPH) | ${version("OpenJPH-")} | BSD-2-Clause |
| [libjpeg-turbo](https://libjpeg-turbo.org/) | ${version("libjpeg-turbo-")} | IJG, BSD-3-Clause, Zlib |
| [libpng](http://www.libpng.org/) | ${version("libpng-")} | libpng-2.0 |
| [libtiff](https://libtiff.gitlab.io/libtiff/) | ${version("tiff-")} | libtiff |
| [FreeType](https://freetype.org/) | ${version("freetype-")} | FTL |
| [zlib](https://zlib.net/) | ${version("zlib-")} | Zlib |
| [Zstandard](https://facebook.github.io/zstd/) | ${version("zstd-")} | BSD-3-Clause |
| [Brotli](https://github.com/google/brotli) | ${version("brotli-")} | MIT |
| [libdeflate](https://github.com/ebiggers/libdeflate) | ${version("libdeflate-")} | MIT |
| [Expat](https://libexpat.github.io/) | ${version("libexpat-")} | MIT |
| [fmt](https://fmt.dev/) | ${version("fmt-")} | MIT |
| [pugixml](https://pugixml.org/) | ${version("pugixml-")} | MIT |
| [robin-map](https://github.com/Tessil/robin-map) | ${version("robin-map-")} | MIT |
| [yaml-cpp](https://github.com/jbeder/yaml-cpp) | ${version("yaml-cpp-")} | MIT |
| [pystring](https://github.com/imageworks/pystring) | ${version("pystring-")} | BSD-3-Clause |
| [minizip-ng](https://github.com/zlib-ng/minizip-ng) | ${version("minizip-ng-")} | Zlib |
| [Eigen](https://eigen.tuxfamily.org/) | ${version("eigen-").slice(0, 12)} | MPL-2.0 |
| [Emscripten](https://emscripten.org/) runtime and system libraries | ${read(join(repo, "emsdk/upstream/emscripten/emscripten-version.txt")).replaceAll('"', "")} | MIT or NCSA; musl: MIT; libc++/libc++abi/compiler-rt: Apache-2.0 WITH LLVM-exception |

Blender's notices below list these libraries too, at the versions Blender's
own builds use, with their license texts.

## Emscripten

${details("Emscripten (MIT / University of Illinois/NCSA)", read(join(emscripten, "LICENSE")))}
${details("musl libc (MIT)", read(join(emscripten, "system/lib/libc/musl/COPYRIGHT")))}
${details("libc++ (Apache-2.0 WITH LLVM-exception)", read(join(emscripten, "system/lib/libcxx/LICENSE.TXT")))}

## Blender's third-party notices

${blenderLicense}
`;
writeFileSync(join(root, "THIRD-PARTY-LICENSES.md"), out);
console.log(`wrote THIRD-PARTY-LICENSES.md (${(out.length / 1024).toFixed(0)} kB)`);
