"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  colorwayHex,
  figureLabel,
  shellFor,
  trimFor,
  trimHex,
  type FigureColorway,
} from "@/lib/merryman-figure";

/**
 * YOUR MERRYMAN, standing up.
 *
 * A procedural full-body robot — no model file, no new host to trust. The
 * trim colour is the worker's mode (lib/merryman-figure.ts), the shoulder
 * fins appear only on the trencher strategy, and the ring only when wired.
 * The shell prop is dress: body colour only, chosen by the owner, and it can
 * never touch trim, fins or ring. Every state difference is a state the
 * agent is actually in; every dress difference is paint.
 *
 * It idles (breath, arm sway, head scan), it turns when dragged, and a tap
 * calls onTap — the screen owns what that opens. Styled inline, not in a
 * sheet: styles/scoped.test.ts pins every rule in web/src/styles under .mm,
 * and this leaf needs none of that machinery.
 */
export function MerrymanFigure({
  mode,
  strategy,
  wired = false,
  colorway = "spectre",
  size = 220,
  onTap,
}: {
  /** Worker-reported mode: "paper" | "live" | "idle" | null. Null is idle. */
  mode: string | null | undefined;
  strategy?: string | null;
  wired?: boolean;
  /** Dress: owner-chosen body colour. Never state. */
  colorway?: FigureColorway;
  size?: number;
  /** Tap (not drag) on the figure. The screen decides what opens. */
  onTap?: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const tap = useRef(onTap);
  tap.current = onTap;
  const trim = trimFor(mode);
  const shell = shellFor(strategy);
  const hex = trimHex(trim);
  const body = colorwayHex(colorway);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const color = new THREE.Color(hex);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 30);
    camera.position.set(0, 0.3, 6.4);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x11131a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 3, 3);
    scene.add(key);
    // Rim: separates a dark body from a black page. Fill: lifts the face.
    const rim = new THREE.DirectionalLight(0x86a8ff, 1.6);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xfff2df, 0.55);
    fill.position.set(0, 0.5, 4);
    scene.add(fill);

    const bot = new THREE.Group();
    scene.add(bot);
    // No environment map on this stage, so true metals render black — the
    // body is a lit plastic instead. Dress lives here and only here.
    const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(body), metalness: 0.25, roughness: 0.45 });
    const black = new THREE.MeshStandardMaterial({ color: 0x020304, metalness: 0.3, roughness: 0.6 });
    const glow = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      // Idle is off: its eyes sit dim, never lit.
      emissiveIntensity: trim === "idle" ? 0.45 : 2.4,
    });

    // Plinth it stands on.
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 0.18, 32), suit);
    base.position.y = -1.75;
    scene.add(base);

    // Legs: thigh, shin, foot. Feet planted, slightly apart.
    const leg = (x: number) => {
      const g = new THREE.Group();
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.6, 16), suit);
      thigh.position.y = -0.85;
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.55, 16), suit);
      shin.position.y = -1.35;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.42), black);
      foot.position.set(0, -1.62, 0.08);
      g.add(thigh, shin, foot);
      g.position.x = x;
      return g;
    };
    const legL = leg(-0.24);
    const legR = leg(0.24);
    bot.add(legL, legR);

    // Hips and torso, chest core glowing with the trim.
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.25, 0.35), suit);
    hips.position.y = -0.5;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 8, 20), suit);
    torso.position.y = 0.05;
    const core = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 12, 32), glow);
    core.position.set(0, 0.1, 0.32);
    bot.add(hips, torso, core);

    // Arms: shoulder joint, upper arm, forearm, hand. Pivot at the shoulder
    // so the wave and the sway read from the right joint.
    const arm = (x: number) => {
      const g = new THREE.Group();
      g.position.set(x, 0.32, 0);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 16), suit);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.45, 14), suit);
      upper.position.y = -0.28;
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.09, 0.4, 14), suit);
      fore.position.y = -0.68;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 14), black);
      hand.position.y = -0.95;
      g.add(joint, upper, fore, hand);
      return g;
    };
    const armL = arm(-0.5);
    const armR = arm(0.5);
    bot.add(armL, armR);

    // Head: neck, helm, visor, two glowing eyes. The trim lives here.
    const head = new THREE.Group();
    head.position.y = 0.78;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.15, 14), black);
    neck.position.y = -0.28;
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 24), suit);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.18, 0.2), black);
    visor.position.set(0, 0.03, 0.22);
    const eyeGeo = new THREE.BoxGeometry(0.13, 0.045, 0.03);
    const eyeL = new THREE.Mesh(eyeGeo, glow);
    eyeL.position.set(-0.11, 0.04, 0.33);
    const eyeR = new THREE.Mesh(eyeGeo, glow);
    eyeR.position.set(0.11, 0.04, 0.33);
    head.add(neck, helm, visor, eyeL, eyeR);
    const gaze = new THREE.PointLight(color, 5, 4);
    gaze.position.set(0, 0.8, 1.1);
    bot.add(head, gaze);

    // Trencher shell: shoulder fins. Strategy, not fashion.
    if (shell === "trencher") {
      const finGeo = new THREE.BoxGeometry(0.1, 0.5, 0.28);
      const finL = new THREE.Mesh(finGeo, suit);
      finL.position.set(-0.62, 0.45, 0);
      finL.rotation.z = 0.18;
      const finR = new THREE.Mesh(finGeo, suit);
      finR.position.set(0.62, 0.45, 0);
      finR.rotation.z = -0.18;
      bot.add(finL, finR);
    }

    // The wired ring: the same ring the feed draws, in the round. Wide enough
    // to orbit the body, never to cut through the head.
    let ring: THREE.Mesh | null = null;
    if (wired) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.5, 0.025, 8, 90),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x22c55e, emissiveIntensity: 1.4 }),
      );
      ring.rotation.x = Math.PI / 2.8;
      ring.position.y = 0.1;
      scene.add(ring);
    }

    // Drag turns it; a tap (not a drag) calls onTap and waves.
    let spin = 0;
    let dragging = false;
    let moved = 0;
    let wave = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      moved += Math.abs(e.movementX);
      spin += e.movementX * 0.01;
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      if (moved < 6) {
        tap.current?.();
        wave = 1;
      }
    };
    const canvas = renderer.domElement;
    canvas.style.touchAction = "pan-y";
    canvas.style.cursor = "pointer";
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      // Idle: breath, sway, slow head scan. Drag adds its own turn.
      if (!dragging) spin += 0.003;
      bot.rotation.y = spin;
      bot.position.y = Math.sin(t * 1.6) * 0.03;
      armL.rotation.z = 0.08 + Math.sin(t * 1.6) * 0.05;
      // The wave: right arm up, then settles back.
      if (wave > 0) wave = Math.max(0, wave - 0.02);
      armR.rotation.z = -(0.08 + Math.sin(t * 1.6) * 0.05) - wave * 2.2;
      head.rotation.y = Math.sin(t * 0.5) * 0.4;
      glow.emissiveIntensity = (trim === "idle" ? 0.45 : 2.4) + Math.sin(t * 2.2) * 0.25;
      if (ring) ring.rotation.z -= 0.004;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
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
  }, [hex, body, trim, shell, wired, size]);

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
