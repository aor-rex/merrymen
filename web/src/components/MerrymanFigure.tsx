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
  kind = "cat",
  yaw = 0,
  turntable = true,
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
  /** Slow turntable when idle. Drag always turns. */
  turntable?: boolean;
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
        // KIT: animal traits bolted to the BONES, so they follow the idle
        // animation. Offsets are world units, divided by the bone's own
        // world scale (armatures carry a large internal scale). Dress.
        wrap.updateMatrixWorld(true);
        const boneScale = (bone: THREE.Object3D) => {
          const v = new THREE.Vector3();
          bone.getWorldScale(v);
          return v.x || 1;
        };
        const hardware = new THREE.MeshStandardMaterial({ color: 0x1a2029, metalness: 0.6, roughness: 0.4 });
        const headBone = model.getObjectByName("Head");
        const bodyBone =
          model.getObjectByName("Hips") ?? model.getObjectByName("Body") ?? model;
        const KIT: Record<FigureKind, { earX: number; earY: number; pointed: boolean; earR: number; tail?: [number, number, number][]; thick: number; tailYaw: number }> = {
          cat: { earX: 0.32, earY: 1.15, pointed: true, earR: 0.34, thick: 0.05, tailYaw: 0, tail: [[0, 0.05, -0.3], [0.1, -0.2, -0.6], [0.2, 0.2, -0.75], [0.15, 0.55, -0.5]] },
          monkey: { earX: 0.2, earY: 0.18, pointed: false, earR: 0.2, thick: 0.06, tailYaw: -0.47, tail: [[0, 0, -0.05], [0.03, -0.15, -0.2], [0.06, 0.1, -0.28], [0.04, 0.35, -0.15]] },
          fox: { earX: 0.45, earY: 1.3, pointed: true, earR: 0.44, thick: 0.12, tailYaw: 0, tail: [[0, 0.05, -0.5], [0.05, -0.15, -0.9], [0.1, 0.25, -1.1], [0.08, 0.6, -0.85]] },
          bear: { earX: 0.5, earY: 1.55, pointed: false, earR: 0.3, thick: 0, tailYaw: 0 },
        };
        const spec = KIT[kind];
        if (headBone) {
          const k = boneScale(headBone);
          const earGeo = spec.pointed
            ? new THREE.ConeGeometry(spec.earR * 0.4 / k, spec.earR / k, 4)
            : new THREE.SphereGeometry(spec.earR / k, 14, 14);
          for (const side of [-1, 1]) {
            const ear = new THREE.Mesh(earGeo, hardware);
            ear.position.set((side * spec.earX) / k, spec.earY / k, 0);
            if (spec.pointed) ear.rotation.z = -side * 0.2;
            else ear.scale.z = 0.6;
            headBone.add(ear);
          }
        }
        if (spec.tail) {
          const k2 = boneScale(bodyBone);
          // Unwind the body's rest yaw so "behind" really means behind.
          const cy = Math.cos(spec.tailYaw);
          const sy = Math.sin(spec.tailYaw);
          const curve = new THREE.CatmullRomCurve3(
            spec.tail.map(([x, y, z]) => new THREE.Vector3((x * cy - z * sy) / k2, y / k2, (x * sy + z * cy) / k2)),
          );
          bodyBone.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 16, spec.thick / k2, 8), hardware));
        }
        // Play something idle: exact Idle first, then any idle, then clip one.
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          const clips = gltf.animations;
          const idle =
            clips.find((c) => /(^|\|)Idle$/i.test(c.name)) ??
            clips.find((c) => /(^|\|)Idle_Neutral$/i.test(c.name)) ??
            clips.find((c) => /idle|survey/i.test(c.name)) ??
            clips[0];
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
      if (!dragging && turntable) spin += 0.003;
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
  }, [hex, paint, trim, shell, wired, kind, yaw, turntable, size]);

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
