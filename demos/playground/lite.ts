// Blender inside the Babylon Lite Playground (https://liteplayground.babylonjs.com).
// Blender runs as WebAssembly in a worker; @knervous/blender-web keeps it and
// this Lite scene in step. Click a mesh to nudge it: the move syncs to Blender.
import * as LITE from "@babylonjs/lite";
import { Project } from "@knervous/blender-web@0.0.3";
import { createBlenderSession } from "@knervous/blender-web@0.0.3/browser";
import { LiteSide } from "@knervous/blender-web@0.0.3/lite";

// The runtime ships in the package; the CDN serves it as-is. Keep its
// version the same as the imports'.
const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.3/runtime/";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await LITE.createEngine(canvas);
    const scene = LITE.createSceneContext(engine);
    const camera = LITE.createArcRotateCamera(-Math.PI / 3, Math.PI / 3, 12, LITE.vec3(0, 0, 0));
    LITE.addToScene(scene, camera);
    LITE.attachControl(camera, canvas, scene);
    LITE.addToScene(scene, LITE.createHemisphericLight([0, 1, 0], 1));
    await LITE.registerScene(scene);
    void LITE.startEngine(engine); // the render loop; settles only when the engine stops

    // Boot progress on screen (the playground page isn't cross-origin
    // isolated, so this is the single-threaded build).
    const label = Object.assign(document.createElement("div"), { style: "position:absolute;top:8px;left:8px;color:#ddd;font:13px sans-serif" });
    canvas.parentElement!.append(label);

    // The project: Blender on one side, this Lite scene (via this page's LITE) on the other.
    const side = new LiteSide(LITE, engine, scene);
    const session = createBlenderSession({
        runtimeUrl: RUNTIME,
        onProgress: (p) => { label.textContent = `Blender: ${p.detail} ${Math.round(p.fraction * 100)}%`; },
    });
    const project = new Project({ session, scene: side });

    await project.newScene(); // Blender's startup cube, light and camera arrive as Lite nodes

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

    // Lite edits: move what you click, then sync (only that change crosses).
    const picker = LITE.createGpuPicker(scene);
    canvas.addEventListener("click", async (event) => {
        const rect = canvas.getBoundingClientRect();
        const hit = await LITE.pickAsync(picker, event.clientX - rect.left, event.clientY - rect.top);
        const node = side.entityOf(hit.pickedMesh);
        if (!node) return;
        node.position.y += 0.5;
        const { sent } = await project.sync();
        label.textContent = `synced ${sent.map((c) => c.op).join(", ")} for ${node.name}`;
    });
}

main().catch(console.error);
