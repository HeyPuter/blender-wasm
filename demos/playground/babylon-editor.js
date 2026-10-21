// Blender editing a real asset inside the Babylon.js Playground (https://playground.babylonjs.com).
// The playground loads Babylon's aerobatic plane with its textures; Blender
// (WebAssembly, in a worker) takes it into one project with this scene and
// turns it into a V formation with its Array and Mirror modifiers. The
// @knervous/blender-web-editor HUD docks on the right: edit in Babylon, run
// Python or RNA calls in Blender, or swap to Blender's own UI and back.

const EDITOR = "https://esm.sh/@knervous/blender-web-editor@0.0.2";
// Blender's runtime (the core package's runtime/, at the version the editor uses).
const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.5/runtime/";
// The hosted Blender UI (the fork's `./build.sh web`) behind the "Blender UI" button.
const BLENDER_UI = "https://blender-web-ui.pcj174.workers.dev/";
const PLANE = "https://assets.babylonjs.com/meshes/aerobatic_plane.glb";

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

export const createScene = async function () {
    const scene = new BABYLON.Scene(engine);
    const camera = new BABYLON.ArcRotateCamera("camera", 1.92, 1.05, 40, new BABYLON.Vector3(-8, 4, -3), scene);
    camera.attachControl(canvas, true);
    // Image-based lighting for the plane's PBR textures.
    scene.createDefaultEnvironment({ createGround: false, createSkybox: false });

    // The editor loads after the scene is returned, so the playground never waits on it.
    void (async () => {
        const [{ mountEditor }, { babylonViewport }] = await Promise.all([import(EDITOR), import(`${EDITOR}/babylon`)]);
        const viewport = babylonViewport(BABYLON, scene, { helpers: true }); // this playground's BABYLON; grid + lights
        const editor = mountEditor({
            container: canvas.parentElement,   // the HUD docks on its right
            viewport,
            runtimeUrl: RUNTIME,               // single-threaded here: the page isn't isolated
            blenderUi: BLENDER_UI,
        });
        await editor.ready;

        // A real asset, loaded by Babylon with its textures, then adopted into the project.
        await viewport.openUntracked(new File([await (await fetch(PLANE)).arrayBuffer()], "aerobatic_plane.glb"));
        scene.animationGroups.forEach((group) => group.stop()); // hold its pose: a spinning propeller is an edit
        viewport.adoptUntracked();
        await editor.project.sync();

        // Blender's modifiers on it. Only the new geometry comes back; Babylon keeps its textured material.
        await editor.project.sync({ script: FORMATION });
        editor.refresh();
    })().catch(console.error);

    return scene;
};
