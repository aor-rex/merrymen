"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  colorwayHex,
  figureLabel,
  shellFor,
  trimFor,
  trimHex,
  type FigureColorway,
  type FigureKind,
} from "@/lib/merryman-figure";

/**
 * YOUR MERRYMAN, as a real model.
 *
 * Each kind is a CC0 model file vendored under web/public/figures (no new
 * host to trust): the robot is RobotExpressive by Tomas Laulhe, the animals
 * are Quaternius. Procedural survives only as the load-failure fallback, so
 * the face never breaks.
 *
 * State still rules the trim: the plinth rim glows the worker's mode
 * (lib/merryman-figure.ts), dorsal fins appear only on the trencher
 * strategy, the ring only when wired. Kind and plinth paint are dress —
 * they never touch trim, fins or ring.
 *
 * Styled inline, not in a sheet: styles/scoped.test.ts pins every rule in
 * web/src/styles under .mm, and this leaf needs none of that machinery.
 */
export function MerrymanFigure({
  mode,
  strategy,
  wired = false,
  colorway = "spectre",
  kind = "robot",
  yaw = 0,
  size = 220,
  onTap,
}: {
  /** Worker-reported mode: "paper" | "live" | "idle" | null. Null is idle. */
  mode: string | null | undefined;
  strategy?: string | null;
  wired?: boolean;
  /** Dress: owner-chosen plinth paint. Never state. */
  colorway?: FigureColorway;
  /** Dress: which model file. Never state. */
  kind?: FigureKind;
  /** Starting turn, radians. Useful for thumbnails; drag adds to it. */
  yaw?: number;
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
  const paint = colorwayHex(colorway);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const color = new THREE.Color(hex);
    let dead = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 30);
    camera.position.set(0, 0.4, 7.6);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x11131a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 3, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x86a8ff, 1.6);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xfff2df, 0.55);
    fill.position.set(0, 0.5, 4);
    scene.add(fill);

    const bot = new THREE.Group();
    scene.add(bot);

    // Plinth it stands on, in the owner's paint. The rim glows the trim.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.1, 0.18, 32),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(paint), metalness: 0.25, roughness: 0.45 }),
    );
    plinth.position.y = -1.55;
    scene.add(plinth);
    const trimRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.02, 0.035, 10, 64),
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: color,
        emissiveIntensity: trim === "idle" ? 0.4 : 1.8,
      }),
    );
    trimRing.rotation.x = Math.PI / 2;
    trimRing.position.y = -1.46;
    scene.add(trimRing);

    // Trencher shell: dorsal fins. Strategy, not fashion.
    if (shell === "trencher") {
      const fins = new THREE.Group();
      const finGeo = new THREE.BoxGeometry(0.1, 0.5, 0.28);
      const finMat = new THREE.MeshStandardMaterial({ color: 0x3a4350, metalness: 0.3, roughness: 0.5 });
      const finL = new THREE.Mesh(finGeo, finMat);
      finL.position.set(-0.3, 1.0, -0.35);
      finL.rotation.z = 0.15;
      const finR = new THREE.Mesh(finGeo, finMat);
      finR.position.set(0.3, 1.0, -0.35);
      finR.rotation.z = -0.15;
      fins.add(finL, finR);
      bot.add(fins);
    }

    // The wired ring: the same ring the feed draws, in the round.
    let ring: THREE.Mesh | null = null;
    if (wired) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.6, 0.025, 8, 90),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x22c55e, emissiveIntensity: 1.4 }),
      );
      ring.rotation.x = Math.PI / 2.8;
      scene.add(ring);
    }

    let mixer: THREE.AnimationMixer | null = null;

    new GLTFLoader().load(
      `/figures/${kind}.glb`,
      (gltf) => {
        if (dead) return;
        const model = gltf.scene;
        // Auto-fit: every model stands ~2.6 tall with feet on the plinth.
        const box = new THREE.Box3().setFromObject(model);
        const dims = new THREE.Vector3();
        box.getSize(dims);
        const center = new THREE.Vector3();
        box.getCenter(center);
        const s = 2.6 / Math.max(dims.y, 0.001);
        const wrap = new THREE.Group();
        wrap.add(model);
        model.position.set(-center.x, -box.min.y, -center.z);
        wrap.scale.setScalar(s);
        wrap.position.y = -1.46;
        bot.add(wrap);
        // Play something idle: prefer a clip with idle in the name.
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          const idle =
            gltf.animations.find((c) => /idle|survey/i.test(c.name)) ?? gltf.animations[0];
          mixer.clipAction(idle).play();
        }
      },
      undefined,
      () => {
        // Never a broken face: a trim-glowing stone when the file fails.
        if (dead) return;
        const stone = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.9, 1),
          new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 1.2 }),
        );
        bot.add(stone);
      },
    );

    // Drag turns it; a tap (not a drag) calls onTap and hops.
    let spin = yaw;
    let dragging = false;
    let moved = 0;
    let hop = 0;
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
        hop = 1;
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
      mixer?.update(0.016);
      if (!dragging) spin += 0.003;
      bot.rotation.y = spin;
      // Tap hop, plus a breath when the file brings no animation.
      if (hop > 0) hop = Math.max(0, hop - 0.03);
      bot.position.y = Math.sin(t * 1.6) * 0.03 + Math.sin(hop * Math.PI) * 0.35;
      if (ring) ring.rotation.z -= 0.004;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      mixer?.stopAllAction();
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
  }, [hex, paint, trim, shell, wired, kind, yaw, size]);

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
