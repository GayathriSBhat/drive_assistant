// Voice orb — the AI Elements <Persona /> (Rive "obsidian" visual), as used in apurva-livekit's
// agent-view, without React. The React wrapper's hooks map onto the plain Rive runtime:
//   useStateMachineInput(...)       → rive.stateMachineInputs("default")
//   useViewModelInstanceColor(...)  → rive.viewModelInstance.color("color").rgb(...)
// Needs the global `rive` from @rive-app/webgl2 (loaded in index.html).

const RIVE_VERSION = "2.37.1"; // matches @rive-app/react-webgl2 4.28 used by apurva-livekit
const STATE_MACHINE = "default"; // always "default" for Elements AI visuals

const SOURCES = {
  obsidian: { src: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/obsidian-2.0.riv", dynamicColor: true },
  halo: { src: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv", dynamicColor: true },
  glint: { src: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/glint-2.0.riv", dynamicColor: true },
  command: { src: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/command-2.0.riv", dynamicColor: true },
};

let wasmConfigured = false;

/**
 * Mount a Persona into `container`.
 * @param {HTMLElement} container
 * @param {{variant?: keyof SOURCES, color?: [number, number, number]}} opts
 * @returns {{setState(s: "idle"|"listening"|"thinking"|"speaking"|"asleep"): void,
 *            setColor(rgb: [number, number, number]): void, destroy(): void}}
 */
export function createPersona(container, { variant = "obsidian", color = [96, 165, 250] } = {}) {
  const Rive = globalThis.rive;
  const source = SOURCES[variant];
  const canvas = document.createElement("canvas");
  canvas.className = "persona-canvas";
  container.appendChild(canvas);
  if (!Rive || !source) {
    console.error("Rive runtime not loaded");
    return { setState() {}, setColor() {}, destroy() { canvas.remove(); } };
  }
  if (!wasmConfigured) {
    // Serve the WASM from the same CDN as the runtime script.
    Rive.RuntimeLoader.setWasmUrl(`https://cdn.jsdelivr.net/npm/@rive-app/webgl2@${RIVE_VERSION}/rive.wasm`);
    wasmConfigured = true;
  }

  let state = "idle";
  let rgb = color;
  let inputs = {};

  const applyState = () => {
    for (const name of ["listening", "thinking", "speaking", "asleep"]) {
      if (inputs[name]) inputs[name].value = state === name;
    }
  };
  const applyColor = () => {
    if (!source.dynamicColor) return;
    r.viewModelInstance?.color("color")?.rgb(...rgb);
  };

  const r = new Rive.Rive({
    src: source.src,
    canvas,
    autoplay: true,
    autoBind: true, // binds the file's default view model instance (useViewModelInstance useDefault)
    stateMachines: STATE_MACHINE,
    onLoad: () => {
      r.resizeDrawingSurfaceToCanvas();
      inputs = Object.fromEntries(r.stateMachineInputs(STATE_MACHINE).map((i) => [i.name, i]));
      applyState();
      applyColor();
    },
    onLoadError: (e) => console.error("Persona failed to load", e),
  });

  const ro = new ResizeObserver(() => r.resizeDrawingSurfaceToCanvas());
  ro.observe(canvas);

  return {
    setState(s) { state = s; applyState(); },
    setColor(c) { rgb = c; applyColor(); },
    destroy() { ro.disconnect(); r.cleanup(); canvas.remove(); },
  };
}
