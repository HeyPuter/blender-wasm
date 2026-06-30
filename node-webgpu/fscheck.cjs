const path = require("node:path");
const createBlenderModule = require(path.join(__dirname, "blender_node.js"));
createBlenderModule({
  arguments: ["--version"],
  locateFile: (p) => path.join(__dirname, p),
  print: () => {}, printErr: () => {},
  preRun: [function (Mod) {
    try {
      console.log("preRun /5.3 exists:", !!Mod.FS.analyzePath("/5.3").exists);
      console.log("preRun root:", Mod.FS.readdir("/"));
    } catch (e) { console.log("preRun FS err:", e.message); }
  }],
}).then((M) => {
  try {
    console.log("post / :", M.FS.readdir("/"));
    console.log("post /5.3 :", M.FS.readdir("/5.3"));
    console.log("post /5.3/scripts :", M.FS.readdir("/5.3/scripts").slice(0, 6));
  } catch (e) { console.log("post FS err:", e.message); }
  process.exit(0);
}).catch((e) => { console.log("ERR", e.message); process.exit(1); });
