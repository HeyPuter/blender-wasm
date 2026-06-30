const path = require("node:path");
const createBlenderModule = require(path.join(__dirname, "blender_node.js"));
createBlenderModule({
  thisProgram: "/blender",
  arguments: ["--factory-startup", "-b", "--python-expr",
              "import bpy; print('BPY_OK', bpy.app.version_string)"],
  locateFile: (p) => path.join(__dirname, p),
  print: (t) => console.log("[o]", t),
  printErr: (t) => console.log("[e]", t),
  preRun: [function (Mod) {
    try {
      Mod.ENV.BLENDER_SYSTEM_SCRIPTS = "/5.3/scripts";
      Mod.ENV.BLENDER_SYSTEM_DATAFILES = "/5.3/datafiles";
    } catch (e) {}
  }],
}).then(() => { console.log("factory resolved"); }).catch((e) => console.log("ERR", e.message));
