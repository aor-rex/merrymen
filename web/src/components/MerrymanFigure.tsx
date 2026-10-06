"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { figureLabel, shellFor, trimFor, trimHex } from "@/lib/merryman-figure";

/**
 * YOUR MERRYMAN, as a figure rather than a face.
 *
 * A procedural robot bust — no model file, no new host to trust. The trim
 * colour is the worker's mode (lib/merryman-figure.ts), the fins appear only
 * on the trencher strategy, and the ring only when wired. Nothing here is a
 * wardrobe: every visible difference is a state the agent is actually in.
 *
 * Styled inline, not in a sheet: styles/scoped.test.ts pins every rule in
 * web/src/styles under .mm, and this leaf needs none of that machinery.
 */
export function MerrymanFigure({
  mode,
  strategy,
  wired = false,
  size = 220,
}: {
  /** Worker-reported mode: "paper" | "live" | "idle" | null. Null is idle. */
  mode: string | null | undefined;
  strategy?: string | null;
  wired?: boolean;
  size?: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const trim = trimFor(mode);
  const shell = shellFor(strategy);
  const hex = trimHex(trim);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const color = new THREE.Color(hex);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 0.5, 4.8);
    camera.lookAt(0, 0.1, 0);

    scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x11131a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 3, 3);
    scene.add(key);
    // Rim: separates a dark bust from a black page. Fill: lifts the face.
    const rim = new THREE.DirectionalLight(0x86a8ff, 1.6);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xfff2df, 0.55);
    fill.position.set(0, 0.5, 4);
    scene.add(fill);

    const bot = new THREE.Group();
    scene.add(bot);
    // No environment map on this stage, so true metals render black — the
    // shell is a lit plastic instead.
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b3542, metalness: 0.25, roughness: 0.45 });
    const black = new THREE.MeshStandardMaterial({ color: 0x020304, metalness: 0.3, roughness: 0.6 });
    const glow = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      // Idle is off: its eyes sit dim, never lit.
      emissiveIntensity: trim === "idle" ? 0.45 : 2.4,
    });

    // Core: a squat capsule, head and torso in one.
    const core = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 0.7, 8, 24), dark);
    bot.add(core);

    // Visor: a black band across the face.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.34, 0.4), black);
    visor.position.set(0, 0.42, 0.42);
    bot.add(visor);

    // Eyes: two glowing bars. The trim colour lives here.
    const eyeGeo = new THREE.BoxGeometry(0.26, 0.07, 0.05);
    const eyeL = new THREE.Mesh(eyeGeo, glow);
    eyeL.position.set(-0.22, 0.44, 0.63);
    const eyeR = new THREE.Mesh(eyeGeo, glow);
    eyeR.position.set(0.22, 0.44, 0.63);
    bot.add(eyeL, eyeR);
    const gaze = new THREE.PointLight(color, 6, 4);
    gaze.position.set(0, 0.44, 1.2);
    bot.add(gaze);

    // Chest light: a small ring over the heart.
    const chest = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 12, 40), glow);
    chest.position.set(0, -0.25, 0.55);
    bot.add(chest);

    // Base: the plinth it sits on. Close under the torso, no hover gap.
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.85, 0.22, 32), dark);
    base.position.y = -0.82;
    scene.add(base);
    bot.position.y = 0.25;

    // Trencher shell: shoulder fins. Strategy, not fashion.
    if (shell === "trencher") {
      const finGeo = new THREE.BoxGeometry(0.12, 0.55, 0.3);
      const finL = new THREE.Mesh(finGeo, dark);
      finL.position.set(-0.78, 0.25, 0);
      finL.rotation.z = 0.18;
      const finR = new THREE.Mesh(finGeo, dark);
      finR.position.set(0.78, 0.25, 0);
      finR.rotation.z = -0.18;
      bot.add(finL, finR);
    }

    // The wired ring: the same ring the feed draws, in the round. Wide enough
    // to orbit the head, never to cut through the visor.
    let ring: THREE.Mesh | null = null;
    if (wired) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.65, 0.025, 8, 90),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x22c55e, emissiveIntensity: 1.4 }),
      );
      ring.rotation.x = Math.PI / 2.8;
      ring.position.y = 0.1;
      scene.add(ring);
    }

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      bot.rotation.y += 0.008;
      if (ring) ring.rotation.z -= 0.004;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      scene.traverse((o: THREE.Object3D) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[];
          (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [hex, trim, shell, wired, size]);

  return (
    <figure style={{ margin: 0, width: size, flex: "none" }} aria-label={`your merryman: ${figureLabel(trim)}`}>
      <div ref={mount} style={{ width: size, height: size }} />
      <figcaption
        className="mono"
        style={{ textAlign: "center", fontSize: 12, color: "#8b93a0", marginTop: 4 }}
      >
        {figureLabel(trim)}
      </figcaption>
    </figure>
  );
}
