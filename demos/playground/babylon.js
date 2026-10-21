// Blender inside the Babylon.js Playground (https://playground.babylonjs.com).
// Blender runs as WebAssembly in a worker; @knervous/blender-web keeps it and
// this scene in step. Click a mesh to nudge it: the move syncs to Blender.

// The package from esm.sh, and its runtime from jsDelivr (keep the versions equal).
const PKG = "https://esm.sh/@knervous/blender-web@0.0.3";
const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.3/runtime/";

export const createScene = async function () {
    const scene = new BABYLON.Scene(engine);
    const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, 12, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    new BABYLON.HemisphericLight("sky", new BABYLON.Vector3(0, 1, 0), scene);

    // Boot progress on screen (the playground page isn't cross-origin
    // isolated, so this is the single-threaded build).
    const label = Object.assign(document.createElement("div"), { style: "position:absolute;top:8px;left:8px;color:#ddd;font:13px sans-serif" });
    canvas.parentElement.append(label);

    // Blender boots after the scene is returned, so the playground never waits on it.
    let side = null;
    let project = null;
    void (async () => {
        const [{ Project }, { createBlenderSession }, { BabylonSide }] = await Promise.all([
            import(PKG), import(`${PKG}/browser`), import(`${PKG}/babylon`),
        ]);
        // The project: Blender on one side, this scene (via the playground's own BABYLON) on the other.
        side = new BabylonSide(BABYLON, scene);
        const session = createBlenderSession({
            runtimeUrl: RUNTIME,
            onProgress: (p) => { label.textContent = `Blender: ${p.detail} ${Math.round(p.fraction * 100)}%`; },
        });
        project = new Project({ session, scene: side });
        await project.newScene(); // Blender's startup cube, light and camera arrive as Babylon nodes

        // Blender models: a smooth monkey with an array, in orange.
        await project.sync({ script: `
import bpy
bpy.ops.mesh.primitive_monkey_add(location=(0, -3, 1))
m = bpy.context.object
m.modifiers.new("row", "ARRAY").count = 3
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new("orange")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.35, 0.05, 1)
m.data.materials.append(mat)
` });
        label.textContent = `Blender ${session.flavor} · booted in ${(session.bootMs / 1000).toFixed(1)} s · click a mesh`;
    })().catch((e) => { label.textContent = String(e); });

    // Babylon edits: move what you click, then sync (only that change crosses).
    scene.onPointerObservable.add(async (info) => {
        if (!project || info.type !== BABYLON.PointerEventTypes.POINTERTAP) return;
        const node = side.entityOf(info.pickInfo?.pickedMesh ?? null);
        if (!node) return;
        node.position.y += 0.5;
        const { sent } = await project.sync();
        label.textContent = `synced ${sent.map((c) => c.op).join(", ")} for ${node.name}`;
    });

    return scene;
};
