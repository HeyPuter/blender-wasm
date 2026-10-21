// Blender editing a real asset inside the Babylon Lite Playground (https://liteplayground.babylonjs.com).
// The playground loads Babylon's aerobatic plane with its textures; Blender
// (WebAssembly, in a worker) takes it into one project with this scene and
// turns it into a V formation with its Array and Mirror modifiers. The
// @knervous/blender-web-editor HUD docks on the right: edit in Lite, run
// Python or RNA calls in Blender, or swap to Blender's own UI and back.
import * as LITE from "@babylonjs/lite";
import { mountEditor } from "@knervous/blender-web-editor@0.0.2";
import { liteViewport } from "@knervous/blender-web-editor@0.0.2/lite";

// Blender's runtime (the core package's runtime/, at the version the editor uses).
const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.5/runtime/";
// The hosted Blender UI (the fork's `./build.sh web`) behind the "Blender UI" button.
const BLENDER_UI = "https://blender-web-ui.pcj174.workers.dev/";
const PLANE = "https://assets.babylonjs.com/meshes/aerobatic_plane.glb";
const ENVIRONMENT = "https://assets.babylonjs.com/environments/environmentSpecular.env";
const BRDF = "https://assets.babylonjs.com/environments/correlatedMSBRDF_RGBD.png";

// Blender's side: the plane at full size, airborne, then copied into a V.
const FORMATION = `
import bpy
for name in ("Cube", "Light", "Camera"):
    bpy.data.objects.remove(bpy.data.objects[name])
plane = next(o for o in bpy.data.objects if o.type == "MESH")
root = plane
while root.parent:
    root = root.parent
root.scale *= 20               # the asset is a 30 cm model
root.location.z = 4
row = plane.modifiers.new("formation", "ARRAY")
row.count = 3
row.relative_offset_displace = (0.85, 0.9, 0)   # out along the wing, back along the fuselage
plane.modifiers.new("wingmen", "MIRROR").use_axis = (True, False, False)
plane.select_set(True)            # selected when you swap to Blender's UI
bpy.context.view_layer.objects.active = plane
`;

async function main(): Promise<void> {
    // The app's scene: engine, camera, lighting and render loop stay the app's.
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await LITE.createEngine(canvas);
    const scene = LITE.createSceneContext(engine);
    const camera = LITE.createArcRotateCamera(1.92, 1.05, 40, LITE.vec3(-12, 4, -3));
    LITE.addToScene(scene, camera);
    LITE.attachControl(camera, canvas, scene);
    LITE.addToScene(scene, LITE.createHemisphericLight([0, 1, 0], 1));
    await LITE.loadEnvironment(scene, ENVIRONMENT, { brdfUrl: BRDF, skipSkybox: true, skipGround: true }); // PBR lighting
    await LITE.registerScene(scene);
    void LITE.startEngine(engine); // the render loop; settles only when the engine stops

    // The editor over it (single-threaded Blender here: the page isn't isolated).
    const viewport = liteViewport(LITE, engine, scene, canvas);
    const editor = mountEditor({ container: canvas.parentElement!, viewport, runtimeUrl: RUNTIME, blenderUi: BLENDER_UI });
    await editor.ready;

    // A real asset, loaded by Lite with its textures, then adopted into the project.
    await viewport.openUntracked(new File([await (await fetch(PLANE)).arrayBuffer()], "aerobatic_plane.glb"));
    viewport.adoptUntracked();
    await editor.project!.sync();

    // Blender's modifiers on it. Only the new geometry comes back; Lite keeps its textured material.
    await editor.project!.sync({ script: FORMATION });
    editor.refresh();
}

main().catch(console.error);
