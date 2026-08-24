import * as THREE from 'three';

// ---------------- court constants (meters) ----------------
// Half-court street setup. Baseline z=0, court extends +z. Sidelines x=±7.5.
export const COURT = {
  halfWidth: 7.5,        // x ∈ [-7.5, 7.5]
  baselineZ: 0,
  halfCourtZ: 14,
  rimCenter: new THREE.Vector3(0, 3.048, 1.575),
  rimRadius: 0.2286,
  rimTube: 0.017,
  rimHeight: 3.048,
  boardFaceZ: 1.22,      // front face of backboard
  boardWidth: 1.83,
  boardHeight: 1.05,
  boardBottomY: 2.90,
  boardTopY: 3.95,
  threeR: 6.75,          // arc radius from rim center
  cornerX: 6.6,          // corner 3 straight-line x
  keyHalfW: 2.45,
  ftZ: 5.8,              // free throw line
  floorY: 0,
};

/** true if world xz is beyond the 3pt arc (street 3 applies) */
export function isBeyondArc(x, z) {
  const r = Math.hypot(x - COURT.rimCenter.x, z - COURT.rimCenter.z);
  if (r >= COURT.threeR) return true;
  // corners: outside straight lines
  if (Math.abs(x) >= COURT.cornerX && z < COURT.rimCenter.z + 1.42) return true;
  return false;
}

/** in-bounds check for half court play area (a little forgiveness at fence) */
export function isInBounds(x, z) {
  return x > -COURT.halfWidth - 0.35 && x < COURT.halfWidth + 0.35 &&
         z > COURT.baselineZ - 0.9 && z < COURT.halfCourtZ + 0.35;
}

// floor plane: 20x20, centred downcourt so the whole play area plus the
// baseline apron fits inside one texture
const FLOOR_SIZE = 20;
const FLOOR_Z = 7;

export function buildCourt(scene) {
  const court = {};

  // ---------------- floor ----------------
  {
    const size = FLOOR_SIZE;
    const tex = makeCourtTexture(size);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.93,
        metalness: 0.0,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, FLOOR_Z);
    floor.receiveShadow = true;
    scene.add(floor);
    court.floor = floor;
  }

  // Street possession changes are not live until the new offense clears the
  // arc. The painted line stays authentic; this thin emissive duplicate only
  // appears while that rule is active, so the player never has to infer it
  // from a disappearing toast.
  {
    const clearMat = new THREE.MeshBasicMaterial({
      color: 0x66ecff, transparent: true, opacity: 0.8,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const clearGuide = new THREE.Group();
    const zJoin = COURT.rimCenter.z + Math.sqrt(COURT.threeR ** 2 - COURT.cornerX ** 2);
    const leftA = Math.atan2(zJoin - COURT.rimCenter.z, -COURT.cornerX);
    const rightA = Math.atan2(zJoin - COURT.rimCenter.z, COURT.cornerX);
    const points = [];
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const a = leftA + (rightA - leftA) * t;
      points.push(new THREE.Vector3(
        COURT.rimCenter.x + Math.cos(a) * COURT.threeR,
        0.022,
        COURT.rimCenter.z + Math.sin(a) * COURT.threeR,
      ));
    }
    const arc = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 72, 0.045, 6, false),
      clearMat,
    );
    clearGuide.add(arc);
    for (const x of [-COURT.cornerX, COURT.cornerX]) {
      const straight = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.035, zJoin),
        clearMat,
      );
      straight.position.set(x, 0.022, zJoin / 2);
      clearGuide.add(straight);
    }
    clearGuide.visible = false;
    clearGuide.renderOrder = 5;
    scene.add(clearGuide);
    court.clearGuide = clearGuide;
    court.setClearGuide = (active, time = 0) => {
      clearGuide.visible = !!active;
      if (!active) return;
      clearMat.opacity = 0.58 + Math.sin(time * 7.5) * 0.2;
      const pulse = 1 + Math.sin(time * 7.5) * 0.008;
      clearGuide.scale.set(pulse, 1, pulse);
    };
  }

  // ---------------- hoop assembly ----------------
  // The 12 net loops are welded onto the ring down here and handed to the net
  // block below, so there is one source of truth for where the cords hang.
  const hoop = new THREE.Group();
  const NET_STRANDS = 12;
  const hookAnchors = [];
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x262a30, roughness: 0.5, metalness: 0.8 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0xc4531f, roughness: 0.85 });
    // anything within a metre of the ring gets a close camera on it at some
    // point: cast steel with a clearcoat, so the floodlights leave a highlight
    // instead of a flat grey patch
    const castMat = new THREE.MeshPhysicalMaterial({
      color: 0x1c2026, roughness: 0.44, metalness: 0.85, clearcoat: 0.45, clearcoatRoughness: 0.3,
    });

    // base + pole behind baseline
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.16, 1.0), steel);
    base.position.set(0, 0.08, -1.55);
    base.castShadow = true; base.receiveShadow = true;
    hoop.add(base);

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 3.9, 24), steel);
    pole.position.set(0, 1.95, -1.55);
    pole.castShadow = true;
    hoop.add(pole);

    const polePad = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 1.15, 24), padMat);
    polePad.position.set(0, 0.58, -1.55);
    hoop.add(polePad);

    // arm from pole to board
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 2.85), steel);
    arm.position.set(0, 3.72, -0.19);
    arm.castShadow = true;
    hoop.add(arm);
    const armDiag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.7), steel);
    armDiag.position.set(0, 3.28, -0.95);
    armDiag.rotation.x = -0.55;
    hoop.add(armDiag);

    // backboard — smoked glass with markings. The box is placed so its front
    // face lands exactly on COURT.boardFaceZ, the plane ball.js rebounds off;
    // it used to sit 5 cm proud of it, so the ball bounced off thin air.
    const BOARD_T = 0.045;
    const boardY = (COURT.boardBottomY + COURT.boardTopY) / 2;
    const boardZ = COURT.boardFaceZ - BOARD_T / 2;
    const boardTex = makeBackboardTexture();
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(COURT.boardWidth, COURT.boardHeight, BOARD_T),
      new THREE.MeshPhysicalMaterial({
        color: 0x93a4b4, transmission: 0.6, opacity: 0.68, transparent: true,
        roughness: 0.055, metalness: 0.0, ior: 1.52, thickness: BOARD_T,
        side: THREE.DoubleSide,
      })
    );
    board.position.set(0, boardY, boardZ);
    board.castShadow = true;
    hoop.add(board);

    // aluminium surround + the padded bottom edge. Without them the glass has
    // no thickness to read against and the board is a floating rectangle.
    const alu = new THREE.MeshStandardMaterial({ color: 0x8d959e, roughness: 0.36, metalness: 0.85 });
    const FR = 0.028;
    const railH = new THREE.BoxGeometry(COURT.boardWidth + FR * 2, FR, BOARD_T + 0.014);
    const railV = new THREE.BoxGeometry(FR, COURT.boardHeight, BOARD_T + 0.014);
    for (const [geo, x, y] of [
      [railH, 0, COURT.boardTopY + FR / 2],
      [railH, 0, COURT.boardBottomY - FR / 2],
      [railV, -(COURT.boardWidth + FR) / 2, boardY],
      [railV, (COURT.boardWidth + FR) / 2, boardY],
    ]) {
      const rail = new THREE.Mesh(geo, alu);
      rail.position.set(x, y, boardZ);
      rail.castShadow = true;
      hoop.add(rail);
    }
    const boardPad = new THREE.Mesh(
      new THREE.BoxGeometry(COURT.boardWidth * 0.66, 0.075, BOARD_T + 0.05),
      new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.9 }));
    boardPad.position.set(0, COURT.boardBottomY - FR - 0.0375, boardZ);
    hoop.add(boardPad);

    // markings sit on the glass and take light — the old unlit plane read as a
    // decal pasted over the scene rather than paint on a surface
    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(COURT.boardWidth, COURT.boardHeight),
      new THREE.MeshStandardMaterial({
        map: boardTex, transparent: true, roughness: 0.45, metalness: 0.0,
        emissive: 0xffffff, emissiveMap: boardTex, emissiveIntensity: 0.09,
      })
    );
    frame.position.set(0, boardY, COURT.boardFaceZ + 0.004);
    hoop.add(frame);

    // rim. Radius and tube are the numbers ball.js collides against, so only
    // the tesselation and the finish are art here; 12 tube segments faceted
    // visibly from a close camera, 20x72 is still under 1500 verts.
    const rimMat = new THREE.MeshPhysicalMaterial({
      color: 0xcf5019, roughness: 0.34, metalness: 0.6, clearcoat: 0.55, clearcoatRoughness: 0.22,
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(COURT.rimRadius, COURT.rimTube, 20, 72), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.copy(COURT.rimCenter);
    rim.castShadow = true;
    hoop.add(rim);

    // net hooks: 12 wire loops threaded over the ring. The old net anchored at
    // rimRadius - 0.012, which is *inside* the 0.017 tube — every strand began
    // buried in the metal, so there was nothing to see joining net to rim. The
    // loops carry the cords out to the underside of the ring, where a real net
    // hangs from, and give the join actual hardware to read as.
    const HOOK_WIRE = 0.0035;
    const HOOK_R = COURT.rimTube + 0.007;
    const hookGeo = new THREE.TorusGeometry(HOOK_R, HOOK_WIRE, 8, 22);
    for (let s = 0; s < NET_STRANDS; s++) {
      const a = (s / NET_STRANDS) * Math.PI * 2;
      const hook = new THREE.Mesh(hookGeo, castMat);
      hook.position.set(
        COURT.rimCenter.x + Math.cos(a) * COURT.rimRadius,
        COURT.rimHeight,
        COURT.rimCenter.z + Math.sin(a) * COURT.rimRadius
      );
      hook.rotation.y = -a;   // loop plane holds the radial direction and Y
      hoop.add(hook);
      // the cord hangs off the bottom wire of the loop, thick enough to
      // overlap it — that overlap is what reads as "threaded through"
      hookAnchors.push(new THREE.Vector3(hook.position.x, COURT.rimHeight - HOOK_R, hook.position.z));
    }

    // rim bracket. The old brace was a bare orange box that read as a plastic
    // tab from underneath; this is the plate/neck/gusset stack a breakaway rim
    // actually hangs off, in dark steel so the ring stays the only orange.
    const rimBackZ = COURT.rimCenter.z - COURT.rimRadius;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.17, 0.022), castMat);
    plate.position.set(0, COURT.rimHeight + 0.012, COURT.boardFaceZ + 0.012);
    plate.castShadow = true;
    hoop.add(plate);

    const neck = new THREE.Mesh(
      new THREE.BoxGeometry(0.085, 0.03, rimBackZ - COURT.boardFaceZ + 0.03), castMat);
    neck.position.set(0, COURT.rimHeight, (COURT.boardFaceZ + rimBackZ) / 2 + 0.008);
    neck.castShadow = true;
    hoop.add(neck);

    for (const sx of [-1, 1]) {
      const gusset = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.085, rimBackZ - COURT.boardFaceZ + 0.02), castMat);
      gusset.position.set(sx * 0.042, COURT.rimHeight - 0.035, (COURT.boardFaceZ + rimBackZ) / 2 + 0.004);
      gusset.rotation.x = 0.16;
      hoop.add(gusset);
      // breakaway spring housings
      const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 16), castMat);
      spring.position.set(sx * 0.055, COURT.rimHeight + 0.042, COURT.boardFaceZ + 0.034);
      hoop.add(spring);
    }

    scene.add(hoop);
    court.hoop = hoop;
    court.rim = rim;
  }

  // ---------------- net (verlet cloth) ----------------
  {
    const STRANDS = NET_STRANDS, LEVELS = 9;
    const NET_LEN = 0.40;
    const topR = COURT.rimRadius;   // cords leave the loops on the ring centreline
    const botR = 0.128;
    const CORD_R = 0.0039, HEM_R = 0.0048, KNOT_R = 0.0058, SIDES = 6;
    const ITERS = 4;

    // Particle grid. Every other row is offset half a cell, so each node has
    // exactly two cords running to the row below: that is the diamond mesh of
    // a real net, and unlike the old ring-and-rung layout it needs no
    // horizontal constraints to keep its shape (the old one fought itself and
    // crumpled into a tangle inside the rim).
    const pts = [], prev = [], restR = [];
    for (let l = 0; l < LEVELS; l++) {
      const t = l / (LEVELS - 1);
      const r = THREE.MathUtils.lerp(topR, botR, Math.pow(t, 0.85));
      const y = COURT.rimHeight - (COURT.rimTube + 0.007) - t * NET_LEN;
      const row = [];
      for (let s = 0; s < STRANDS; s++) {
        if (l === 0) { row.push(hookAnchors[s].clone()); continue; }
        const a = (s / STRANDS) * Math.PI * 2 + (l % 2) * (Math.PI / STRANDS);
        row.push(new THREE.Vector3(
          COURT.rimCenter.x + Math.cos(a) * r, y, COURT.rimCenter.z + Math.sin(a) * r));
      }
      pts.push(row); prev.push(row.map(p => p.clone())); restR.push(r);
    }

    // Cords. The simulated constraint set and the drawn tubes are the same
    // list, so a cord can never be solved in one place and drawn in another.
    const cordA = [], cordB = [], cordRest = [], cordRad = [], cordPin = [];
    const addCord = (a, b, rad, pin, slack) => {
      cordA.push(a); cordB.push(b); cordRad.push(rad); cordPin.push(pin ? 1 : 0);
      cordRest.push(a.distanceTo(b) * slack);
    };
    for (let l = 0; l < LEVELS - 1; l++) {
      const twist = l % 2 ? 1 : -1;   // which way the half-cell offset leans
      for (let s = 0; s < STRANDS; s++) {
        addCord(pts[l][s], pts[l + 1][s], CORD_R, l === 0, 1);
        addCord(pts[l][s], pts[l + 1][(s + twist + STRANDS) % STRANDS], CORD_R, l === 0, 1);
      }
    }
    const hem = pts[LEVELS - 1];
    for (let s = 0; s < STRANDS; s++) addCord(hem[s], hem[(s + 1) % STRANDS], HEM_R, false, 0.97);
    const CORDS = cordA.length;
    const restLen = new Float32Array(cordRest), radius = new Float32Array(cordRad);
    const pinned = new Uint8Array(cordPin);

    // Drawn as tubes, not lines: LineSegments are one pixel wide at any
    // distance, which is exactly why the old net read as a scribble floating
    // near the rim. Every cord is a 6-sided tube and every crossing carries a
    // knot; the buffers are sized once here and rewritten in place per frame.
    const NODES = LEVELS * STRANDS;
    const KNOT_OFF = new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
    const KNOT_FACE = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 0, 4, 3, 4, 1, 3, 1, 5, 3, 5, 0, 3];
    const knotBase = CORDS * SIDES * 2;
    const vertCount = knotBase + NODES * 6;
    const pos = new Float32Array(vertCount * 3);
    const nrm = new Float32Array(vertCount * 3);
    const index = new Uint16Array(CORDS * SIDES * 6 + NODES * KNOT_FACE.length);
    let ii = 0;
    for (let i = 0; i < CORDS; i++) {
      const b0 = i * SIDES * 2, b1 = b0 + SIDES;
      for (let k = 0; k < SIDES; k++) {
        const k1 = (k + 1) % SIDES;
        index[ii++] = b0 + k; index[ii++] = b1 + k; index[ii++] = b1 + k1;
        index[ii++] = b0 + k; index[ii++] = b1 + k1; index[ii++] = b0 + k1;
      }
    }
    for (let j = 0; j < NODES; j++) {
      const b = knotBase + j * 6;
      for (let f = 0; f < KNOT_FACE.length; f++) index[ii++] = b + KNOT_FACE[f];
      // a knot only ever translates, so its normals are written once
      for (let v = 0; v < 6; v++) {
        nrm[(b + v) * 3] = KNOT_OFF[v * 3];
        nrm[(b + v) * 3 + 1] = KNOT_OFF[v * 3 + 1];
        nrm[(b + v) * 3 + 2] = KNOT_OFF[v * 3 + 2];
      }
    }
    const cosT = new Float32Array(SIDES), sinT = new Float32Array(SIDES);
    for (let k = 0; k < SIDES; k++) {
      cosT[k] = Math.cos((k / SIDES) * Math.PI * 2);
      sinT[k] = Math.sin((k / SIDES) * Math.PI * 2);
    }

    const netGeo = new THREE.BufferGeometry();
    netGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    netGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
    netGeo.setIndex(new THREE.BufferAttribute(index, 1));
    const netMesh = new THREE.Mesh(netGeo, new THREE.MeshStandardMaterial({
      color: 0xe6ebf0, roughness: 0.66, metalness: 0.02,
    }));
    netMesh.frustumCulled = false;
    scene.add(netMesh);

    const rimW = new THREE.Vector3();
    let windT = 0;

    court.net = {
      mesh: netMesh,
      kick(ball) {
        const vx = ball?.vel.x ?? 0, vz = ball?.vel.z ?? 0;
        for (let l = 1; l < LEVELS; l++) {
          const f = l / (LEVELS - 1);
          for (let s = 0; s < STRANDS; s++) {
            const p = pts[l][s], pr = prev[l][s];
            const dx = p.x - rimW.x, dz = p.z - rimW.z;
            const len = Math.max(1e-4, Math.hypot(dx, dz));
            // Verlet velocity is current minus previous: move previous upward
            // and inward to make the scored ball snap the mesh down and open.
            pr.x -= (vx * 0.016 + dx / len * 0.070) * f;
            pr.y += 0.085 * f;
            pr.z -= (vz * 0.016 + dz / len * 0.070) * f;
          }
        }
      },
      update(dt, ball) {
        windT += dt;
        // The anchors ride the rim. game.js tilts the whole hoop group by up to
        // 0.05 rad on contact, which swings the ring ~15 cm; a net that stayed
        // put through that was the loudest tell that it was not attached.
        hoop.updateMatrix();
        for (let s = 0; s < STRANDS; s++) pts[0][s].copy(hookAnchors[s]).applyMatrix4(hoop.matrix);
        rimW.copy(COURT.rimCenter).applyMatrix4(hoop.matrix);

        // integrate. Gravity is full strength and the damping does the work of
        // making cord feel like cord — at -5.5 with 0.985 damping the net used
        // to float back into place like it was underwater.
        const g = -9.2 * dt * dt;
        const dampV = 0.968;
        // idle breeze, so a net at rest is never a frozen prop
        const swayX = (Math.sin(windT * 0.9) + 0.6 * Math.sin(windT * 2.3 + 1.7)) * 0.5 * dt * dt;
        const swayZ = Math.cos(windT * 0.75 + 0.4) * 0.35 * dt * dt;
        for (let l = 1; l < LEVELS; l++) {
          const lf = l / (LEVELS - 1);
          const rr = restR[l];
          for (let s = 0; s < STRANDS; s++) {
            const p = pts[l][s], pr = prev[l][s];
            const vx = (p.x - pr.x) * dampV, vy = (p.y - pr.y) * dampV, vz = (p.z - pr.z) * dampV;
            pr.copy(p);
            p.x += vx + swayX * lf; p.y += vy + g; p.z += vz + swayZ * lf;
            // Cord stiffness. A diamond mesh on its own is a mechanism: it
            // folds flat under its own weight. Pulling each row back toward its
            // design radius keeps the cone open, and it is also what snaps the
            // net back after a ball has punched through it.
            const dx = p.x - rimW.x, dz = p.z - rimW.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > 1e-4) {
              const k = (rr - d) * 90 * dt * dt / d;
              p.x += dx * k; p.z += dz * k;
            }
          }
        }

        // ball push
        if (ball && ball.isLive()) {
          const bc = ball.mesh.position;
          const r = ball.radius + CORD_R + 0.006;
          // the cord is dragged along with the ball, which is what makes the
          // net flick up behind it instead of merely bulging out of the way
          const dragX = ball.vel.x * dt * 0.4, dragY = ball.vel.y * dt * 0.4, dragZ = ball.vel.z * dt * 0.4;
          for (let l = 1; l < LEVELS; l++) {
            for (let s = 0; s < STRANDS; s++) {
              const p = pts[l][s];
              const dx = p.x - bc.x, dy = p.y - bc.y, dz = p.z - bc.z;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < r * r && d2 > 1e-8) {
                const d = Math.sqrt(d2);
                const push = (r - d) / d;
                p.x += dx * push; p.y += dy * push; p.z += dz * push;
                const pr = prev[l][s];
                pr.x -= dragX; pr.y -= dragY; pr.z -= dragZ;
              }
            }
          }
        }

        // constraints
        for (let it = 0; it < ITERS; it++) {
          for (let i = 0; i < CORDS; i++) {
            const a = cordA[i], b = cordB[i];
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < 1e-6) continue;
            // a pinned end cannot give, so the whole correction goes to b —
            // half of it, as the old solver did, let the top row stretch away
            // from the ring under a hard shot
            const diff = (d - restLen[i]) / d * (pinned[i] ? 1 : 0.5);
            if (!pinned[i]) { a.x += dx * diff; a.y += dy * diff; a.z += dz * diff; }
            b.x -= dx * diff; b.y -= dy * diff; b.z -= dz * diff;
          }
        }

        // The net cannot climb over the ring. game.js swings the hoop 0.05 rad
        // on contact, which throws the anchors ~15 cm inside a couple of
        // frames; with no ceiling the top row gets catapulted through the rim
        // plane and the whole cone settles inside-out above the ring.
        const capY = rimW.y + 0.01;
        for (let l = 1; l < LEVELS; l++) {
          for (let s = 0; s < STRANDS; s++) {
            const p = pts[l][s];
            if (p.y > capY) { p.y = capY; prev[l][s].y = capY; }
          }
        }

        // ---- write geometry in place ----
        for (let i = 0; i < CORDS; i++) {
          const a = cordA[i], b = cordB[i], rad = radius[i];
          let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          dx /= len; dy /= len; dz /= len;
          // ring frame: cross the cord with whichever axis it leans on least
          let ux, uy, uz;
          if (Math.abs(dy) < 0.9) { ux = -dz; uy = 0; uz = dx; }
          else { ux = 0; uy = dz; uz = -dy; }
          const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1e-6;
          ux /= ul; uy /= ul; uz /= ul;
          const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
          const o0 = i * SIDES * 6, o1 = o0 + SIDES * 3;
          for (let k = 0; k < SIDES; k++) {
            const c = cosT[k], s = sinT[k];
            const nx = ux * c + vx * s, ny = uy * c + vy * s, nz = uz * c + vz * s;
            const i0 = o0 + k * 3, i1 = o1 + k * 3;
            pos[i0] = a.x + nx * rad; pos[i0 + 1] = a.y + ny * rad; pos[i0 + 2] = a.z + nz * rad;
            pos[i1] = b.x + nx * rad; pos[i1 + 1] = b.y + ny * rad; pos[i1 + 2] = b.z + nz * rad;
            nrm[i0] = nx; nrm[i0 + 1] = ny; nrm[i0 + 2] = nz;
            nrm[i1] = nx; nrm[i1 + 1] = ny; nrm[i1 + 2] = nz;
          }
        }
        let w = knotBase * 3;
        for (let l = 0; l < LEVELS; l++) {
          for (let s = 0; s < STRANDS; s++) {
            const p = pts[l][s];
            for (let v = 0; v < 6; v++) {
              pos[w++] = p.x + KNOT_OFF[v * 3] * KNOT_R;
              pos[w++] = p.y + KNOT_OFF[v * 3 + 1] * KNOT_R;
              pos[w++] = p.z + KNOT_OFF[v * 3 + 2] * KNOT_R;
            }
          }
        }
        netGeo.attributes.position.needsUpdate = true;
        netGeo.attributes.normal.needsUpdate = true;
      },
    };
  }

  return court;
}

// ---------------------------------------------------------------- textures

function makeCourtTexture(size) {
  const W = 2048;
  const c = document.createElement('canvas');
  c.width = W; c.height = W;
  const ctx = c.getContext('2d');
  // The floor plane is 20x20 centred at z = FLOOR_Z, so the canvas covers
  // x in [-10, 10] but z in [FLOOR_Z-10, FLOOR_Z+10]. Canvas +y maps to world
  // +z (plane is rotated -90 deg about x, and CanvasTexture flips y), so the
  // two axes need different offsets -- a single px() put every marking 7 m
  // downcourt of where it belonged.
  const px = (m) => (m + 10) / 20 * W;                 // world x
  const pz = (m) => (m - FLOOR_Z + 10) / 20 * W;       // world z

  // --- asphalt base ---
  ctx.fillStyle = '#3a3e45';
  ctx.fillRect(0, 0, W, W);
  // asphalt noise
  const rand = mulberry32(42);
  for (let i = 0; i < 26000; i++) {
    const x = rand() * W, y = rand() * W;
    const v = rand();
    ctx.fillStyle = v < 0.5
      ? `rgba(0,0,0,${0.04 + rand() * 0.1})`
      : `rgba(255,255,255,${0.015 + rand() * 0.05})`;
    ctx.fillRect(x, y, 1 + rand() * 2.5, 1 + rand() * 2.5);
  }
  // large tonal patches
  for (let i = 0; i < 26; i++) {
    const x = rand() * W, y = rand() * W, r = 120 + rand() * 380;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rand() < 0.6;
    g.addColorStop(0, dark ? 'rgba(20,22,26,0.10)' : 'rgba(200,208,220,0.05)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // cracks
  ctx.strokeStyle = 'rgba(12,13,16,0.5)';
  for (let i = 0; i < 9; i++) {
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    let x = rand() * W, y = rand() * W;
    ctx.moveTo(x, y);
    for (let s = 0; s < 7; s++) {
      x += (rand() - 0.5) * 260; y += (rand() - 0.5) * 260;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // --- painted court surface (worn) ---
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = '#205f63';
  ctx.fillRect(px(-7.5), pz(0), px(7.5) - px(-7.5), pz(14) - pz(0));
  ctx.globalAlpha = 1;

  // Broad colour blocking gives the court a designed street-league identity
  // from the broadcast camera without inventing extra rules or noisy decals.
  ctx.fillStyle = 'rgba(22,72,80,.46)';
  ctx.beginPath();
  ctx.moveTo(px(-7.5), pz(14)); ctx.lineTo(px(0), pz(8.7));
  ctx.lineTo(px(7.5), pz(14)); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(83,183,194,.09)';
  ctx.fillRect(px(-7.5), pz(0), px(1.15) - px(-7.5), pz(14) - pz(0));

  // wear scuffs on paint
  for (let i = 0; i < 340; i++) {
    const x = px(-7.5 + rand() * 15), y = pz(0 + rand() * 14);
    const r = 4 + rand() * 26;
    ctx.fillStyle = `rgba(58,62,69,${0.05 + rand() * 0.22})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.4 + rand() * 0.8), rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const lw = Math.max(3, W / 20 * 0.05);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(238,242,246,0.92)';
  ctx.lineWidth = lw;

  // boundary
  ctx.strokeRect(px(-7.5), pz(0), px(7.5) - px(-7.5), pz(14) - pz(0));

  // key (paint)
  ctx.fillStyle = 'rgba(178,60,32,0.9)';
  ctx.fillRect(px(-COURT.keyHalfW), pz(0), px(COURT.keyHalfW) - px(-COURT.keyHalfW), pz(COURT.ftZ) - pz(0));
  ctx.strokeRect(px(-COURT.keyHalfW), pz(0), px(COURT.keyHalfW) - px(-COURT.keyHalfW), pz(COURT.ftZ) - pz(0));

  // FT circle
  ctx.beginPath();
  ctx.arc(px(0), pz(COURT.ftZ), (1.8 / 20) * W, 0, Math.PI * 2);
  ctx.stroke();

  // 3pt arc + corners
  ctx.beginPath();
  const zCornerJoin = COURT.rimCenter.z + Math.sqrt(COURT.threeR ** 2 - COURT.cornerX ** 2);
  ctx.moveTo(px(-COURT.cornerX), pz(0));
  ctx.lineTo(px(-COURT.cornerX), pz(zCornerJoin));
  // anticlockwise: the sweep has to pass in front of the rim (+z). Drawing it
  // clockwise ran the arc behind the baseline, so the line bulged towards the
  // hoop instead of away from it.
  ctx.arc(px(COURT.rimCenter.x), pz(COURT.rimCenter.z), (COURT.threeR / 20) * W,
    Math.atan2(zCornerJoin - COURT.rimCenter.z, -COURT.cornerX - COURT.rimCenter.x), Math.atan2(zCornerJoin - COURT.rimCenter.z, COURT.cornerX - COURT.rimCenter.x), true);
  ctx.lineTo(px(COURT.cornerX), pz(0));
  ctx.stroke();

  // half-court line + circle
  ctx.beginPath();
  ctx.moveTo(px(-7.5), pz(14));
  ctx.lineTo(px(7.5), pz(14));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px(0), pz(14), (1.8 / 20) * W, 0, Math.PI * 2);
  ctx.stroke();

  // restricted arc under rim
  ctx.beginPath();
  ctx.arc(px(COURT.rimCenter.x), pz(COURT.rimCenter.z), (1.25 / 20) * W, 0, Math.PI);
  ctx.stroke();

  // center text
  ctx.save();
  ctx.translate(px(0), pz(9.2));
  ctx.font = `900 ${Math.round(W / 20 * 1.5)}px 'Arial Black', Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(238,242,246,0.16)';
  ctx.fillText('VIBE', 0, 0);
  ctx.strokeStyle = 'rgba(238,242,246,0.12)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(0, 0, (2.45 / 20) * W, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // paint wear over lines (subtle)
  for (let i = 0; i < 60; i++) {
    const x = px(-7 + rand() * 14), y = pz(0.2 + rand() * 13.6);
    const r = 3 + rand() * 14;
    ctx.fillStyle = `rgba(29,90,94,${0.1 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.6, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(c);
  return t;
}

function makeBackboardTexture() {
  const W = 512, H = 300;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  // border
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 14;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  // inner square (0.59m wide × 0.45m tall above rim)
  const sw = (0.59 / COURT.boardWidth) * W;
  const sh = (0.45 / COURT.boardHeight) * H;
  const sx = (W - sw) / 2;
  const bottomMargin = (COURT.rimHeight - COURT.boardBottomY) / COURT.boardHeight; // rim above bottom
  const sy = H - bottomMargin * H - sh;
  ctx.lineWidth = 10;
  ctx.strokeRect(sx, sy, sw, sh);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
