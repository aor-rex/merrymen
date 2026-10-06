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
 * A procedural humanoid robot — no model file, no new host to trust. The
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
    camera.position.set(0, 0.1, 7.2);
    camera.lookAt(0, -0.1, 0);

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
    const joint = new THREE.MeshStandardMaterial({ color: 0x0b0e13, metalness: 0.3, roughness: 0.6 });
    const glow = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      // Idle is off: its eyes sit dim, never lit.
      emissiveIntensity: trim === "idle" ? 0.45 : 2.4,
    });

    // Plinth it stands on.
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.1, 0.18, 32), suit);
    base.position.y = -1.95;
    scene.add(base);

    // LEGS: shoe, shin, knee, thigh. Feet planted, slightly apart.
    const leg = (x: number) => {
      const g = new THREE.Group();
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.55, 16), suit);
      thigh.position.y = -1.0;
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 14), joint);
      knee.position.y = -1.3;
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.5, 16), suit);
      shin.position.y = -1.58;
      const ankle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), joint);
      ankle.position.y = -1.82;
      // Shoe: longer than it is wide, toe forward.
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.46), joint);
      shoe.position.set(0, -1.86, 0.09);
      g.add(thigh, knee, shin, ankle, shoe);
      g.position.x = x;
      return g;
    };
    bot.add(leg(-0.26), leg(0.26));

    // HIPS and WAIST: pelvis block tapering into a narrower waist.
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.28, 0.38), suit);
    pelvis.position.y = -0.62;
    const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.3, 16), joint);
    waist.position.y = -0.36;
    bot.add(pelvis, waist);

    // CHEST: broad at the shoulders, tapering down. The trim lives here.
    const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.28, 0.62, 20), suit);
    chest.position.y = 0.08;
    chest.scale.z = 0.72;
    const core = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 12, 32), glow);
    core.position.set(0, 0.12, 0.3);
    // Trapezius slope from neck out to the shoulders.
    const traps = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.46, 0.22, 4, 1), suit);
    traps.position.y = 0.44;
    traps.rotation.y = Math.PI / 4;
    traps.scale.z = 0.7;
    bot.add(chest, core, traps);

    // ARMS: deltoid, upper arm, elbow, forearm, palm, fingers. Pivot at the
    // shoulder so the wave and the sway read from the right joint.
    const arm = (x: number) => {
      const g = new THREE.Group();
      g.position.set(x, 0.4, 0);
      const delt = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), suit);
      delt.scale.set(1, 1.15, 1);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.42, 14), suit);
      upper.position.y = -0.3;
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), joint);
      elbow.position.y = -0.52;
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.085, 0.38, 14), suit);
      fore.position.y = -0.74;
      // Hand: palm block plus three finger stubs.
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.06), joint);
      palm.position.y = -1.0;
      const fingers = new THREE.Group();
      for (let i = -1; i <= 1; i++) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.12, 0.05), joint);
        f.position.set(i * 0.05, -1.12, 0);
        fingers.add(f);
      }
      g.add(delt, upper, elbow, fore, palm, fingers);
      return g;
    };
    const armL = arm(-0.56);
    const armR = arm(0.56);
    bot.add(armL, armR);

    // HEAD: neck, skull, jaw, visor, two glowing eyes. The trim lives here.
    const head = new THREE.Group();
    head.position.y = 0.92;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.18, 14), joint);
    neck.position.y = -0.32;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 24), suit);
    skull.scale.set(0.92, 1.08, 0.98);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.3), suit);
    jaw.position.set(0, -0.24, 0.04);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.16, 0.18), joint);
    visor.position.set(0, 0.04, 0.22);
    const eyeGeo = new THREE.BoxGeometry(0.12, 0.04, 0.03);
    const eyeL = new THREE.Mesh(eyeGeo, glow);
    eyeL.position.set(-0.105, 0.05, 0.32);
    const eyeR = new THREE.Mesh(eyeGeo, glow);
    eyeR.position.set(0.105, 0.05, 0.32);
    head.add(neck, skull, jaw, visor, eyeL, eyeR);
    const gaze = new THREE.PointLight(color, 5, 4);
    gaze.position.set(0, 0.9, 1.2);
    bot.add(head, gaze);

    // Trencher shell: shoulder fins. Strategy, not fashion.
    if (shell === "trencher") {
      const finGeo = new THREE.BoxGeometry(0.1, 0.55, 0.3);
      const finL = new THREE.Mesh(finGeo, suit);
      finL.position.set(-0.66, 0.55, -0.1);
      finL.rotation.z = 0.18;
      const finR = new THREE.Mesh(finGeo, suit);
      finR.position.set(0.66, 0.55, -0.1);
      finR.rotation.z = -0.18;
      bot.add(finL, finR);
    }

    // The wired ring: the same ring the feed draws, in the round. Wide enough
    // to orbit the body, never to cut through the head.
    let ring: THREE.Mesh | null = null;
    if (wired) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.6, 0.025, 8, 90),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x22c55e, emissiveIntensity: 1.4 }),
      );
      ring.rotation.x = Math.PI / 2.8;
      ring.position.y = 0;
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
