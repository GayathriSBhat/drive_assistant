"use client";

// AI Elements <Persona /> (Rive), as used in apurva-livekit's agent view — tinted Kenpath marigold.
import type { RiveParameters } from "@rive-app/react-webgl2";
import {
  useRive,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
} from "@rive-app/react-webgl2";
import type { FC, ReactNode } from "react";
import { memo, useEffect, useState } from "react";

export type PersonaState = "idle" | "listening" | "thinking" | "speaking" | "asleep";

// The state machine name is always "default" for Elements AI visuals.
const STATE_MACHINE = "default";
const STATE_INPUTS = ["listening", "thinking", "speaking", "asleep"];

const sources = {
  command: { dynamicColor: true, hasModel: true, source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/command-2.0.riv" },
  glint: { dynamicColor: true, hasModel: true, source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/glint-2.0.riv" },
  halo: { dynamicColor: true, hasModel: true, source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv" },
  obsidian: { dynamicColor: true, hasModel: true, source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/obsidian-2.0.riv" },
};

/** Kenpath marigold, the brand's single accent. */
export const KENPATH_MARIGOLD: [number, number, number] = [237, 170, 87];

// Delays Rive initialisation by one frame so React Strict Mode's immediate unmount never
// creates a WebGL2 context; only the real mount initialises (avoids context exhaustion).
const useStrictModeSafeInit = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => {
      cancelAnimationFrame(id);
      setReady(false);
    };
  }, []);
  return ready;
};

interface WithModelProps {
  rive: ReturnType<typeof useRive>["rive"];
  color: [number, number, number];
  dynamicColor: boolean;
  children: ReactNode;
}

const PersonaWithModel = memo(({ rive, color, dynamicColor, children }: WithModelProps) => {
  const viewModel = useViewModel(rive, { useDefault: true });
  const viewModelInstance = useViewModelInstance(viewModel, { rive, useDefault: true });
  const colorInput = useViewModelInstanceColor("color", viewModelInstance);
  const [r, g, b] = color;

  useEffect(() => {
    if (colorInput && dynamicColor) colorInput.setRgb(r, g, b);
  }, [colorInput, dynamicColor, r, g, b]);

  return children;
});
PersonaWithModel.displayName = "PersonaWithModel";

interface PersonaProps {
  state: PersonaState;
  variant?: keyof typeof sources;
  color?: [number, number, number];
  className?: string;
  onLoadError?: RiveParameters["onLoadError"];
}

export const Persona: FC<PersonaProps> = memo(({ state, variant = "obsidian", color = KENPATH_MARIGOLD, className, onLoadError }) => {
  const source = sources[variant];
  const ready = useStrictModeSafeInit();
  const { rive, RiveComponent } = useRive(
    ready ? { src: source.source, stateMachines: STATE_MACHINE, autoplay: true, onLoadError } : null,
  );

  // The state machine exposes boolean inputs named after the states; exactly one is on.
  useEffect(() => {
    if (!rive) return;
    for (const input of rive.stateMachineInputs(STATE_MACHINE) ?? []) {
      if (STATE_INPUTS.includes(input.name)) input.value = input.name === state;
    }
  }, [rive, state]);

  return (
    <PersonaWithModel rive={rive} color={color} dynamicColor={source.dynamicColor}>
      <RiveComponent className={className} />
    </PersonaWithModel>
  );
});
Persona.displayName = "Persona";
