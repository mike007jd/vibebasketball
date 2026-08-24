import * as THREE from 'three';

/**
 * Night street environment: dusk sky, city skyline, floodlights, fences.
 * Court space: baseline z=0, half-court z=14, x∈[-7.5,7.5]. Hoop at z≈1.575.
 */
export function buildEnvironment(scene, renderer) {
  const env = {};

  scene.fog = new THREE.FogExp2(0x070a13, 0.0105);
  scene.background = new THREE.Color(0x05070d);

  // ---------------- sky dome ----------------
  {
    const skyGeo = new THREE.SphereGeometry(400, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x050a18) },
        mid: { value: new THREE.Color(0x0d1830) },
        horizon: { value: new THREE.Color(0x2a3550) },
        glow: { value: new THREE.Color(0x8a5a3a) },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vPos;
        uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 glow;
        void main() {
          vec3 d = normalize(vPos);
          float h = d.y;
          vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, h));
          col = mix(col, top, smoothstep(0.15, 0.65, h));
          // warm city glow near horizon
          float g = pow(max(0.0, 1.0 - abs(h) * 6.0), 2.0);
          col += glow * g * 0.35;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    scene.add(sky);
    env.sky = sky;
  }

  // ---------------- stars ----------------
  {
    const n = 900;
    const pos = new Float32Array(n * 3);
    const sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // upper hemisphere on radius ~380
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(Math.random() * 0.85 + 0.1); // avoid horizon band
      const r = 380;
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.cos(p);
      pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
      sz[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.PointsMaterial({
      color: 0xbfd0ff, size: 1.35, sizeAttenuation: false,
      transparent: true, opacity: 0.75, depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
  }

  // ---------------- city skyline ----------------
  {
    const cityTex = makeWindowTexture();
    const group = new THREE.Group();
    const rand = mulberry32(7);
    for (let i = 0; i < 46; i++) {
      const ang = (i / 46) * Math.PI * 2 + rand() * 0.12;
      const radius = 75 + rand() * 80;
      const w = 12 + rand() * 22;
      const h = 14 + rand() * 58;
      const d = 12 + rand() * 22;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.62, 0.25, 0.05 + rand() * 0.04),
        roughness: 0.9, metalness: 0.1,
        emissive: 0xffffff, emissiveMap: cityTex, emissiveIntensity: 1.5,
      });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      b.position.set(Math.cos(ang) * radius, h / 2 - 0.5, Math.sin(ang) * radius + 7);
      b.rotation.y = rand() * Math.PI;
      group.add(b);
      // red beacon on tall towers
      if (h > 50 && rand() > 0.4) {
        const beacon = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xff2222 })
        );
        beacon.position.set(b.position.x, h - 0.5, b.position.z);
        group.add(beacon);
        (env.beacons ||= []).push(beacon);
      }
    }
    scene.add(group);
  }

  // ---------------- distant ground ----------------
  {
    const g = new THREE.Mesh(
      new THREE.CircleGeometry(380, 48),
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 1 })
    );
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.06;
    scene.add(g);
  }

  // ---------------- lights ----------------
  {
    // Ambient floor. This used to be 0.8, which is most of the reason the court
    // read as flat: it filled every shadowed face back in, so nothing had a lit
    // side and an unlit side. It is now only doing the job it should — keeping
    // the shadowed halves readable instead of crushed.
    const hemi = new THREE.HemisphereLight(0x2c3d66, 0x0d0b09, 0.22);
    scene.add(hemi);

    // The moon is the back rim. It rakes in from behind the hoop so the athletes
    // keep a cool lit edge against a black fence, which is what separates them
    // from the background at broadcast distance. It no longer casts: switching it
    // off on the live scene moved the floor by 1.2% where the banks moved it by
    // 82%, so it was paying for a shadow map every frame to draw a shadow that
    // was three quarters of a percent of the floor deep. The banks own that now.
    const moon = new THREE.DirectionalLight(0xa8c0ff, 2.0);
    // deliberately low over the skyline: elevation is what decides how much of
    // this lands on the floor, and floor light from a second direction is exactly
    // what dilutes the banks' shadows
    moon.position.set(-20, 8, -26);
    scene.add(moon);
    scene.add(moon.target);
    moon.target.position.set(0, 1.2, 7);
    env.moon = moon;

    // warm fill bounce from court lights
    const fill = new THREE.DirectionalLight(0xffd9a8, 0.18);
    fill.position.set(18, 10, 18);
    scene.add(fill);
  }

  // Floodlight poles + spot lights.
  //
  // The four banks are deliberately unequal, and that inequality is what buys the
  // shadow: four identical sources lit every face of everything from every side,
  // so a blocked one took away too small a share to see. One pole is the key and
  // the only caster, the diagonally opposite pole is a cross-key that keeps the
  // far half from going black, and the last two are fill at an eighth of the key.
  // Measured on open court beside the athlete, the core of a cast shadow now
  // sits 45% below the unshadowed floor; before this it was 2%, which is to say
  // no pixel on the court was ever measurably in shadow.
  //
  // The cross-key was tried as a second caster and did not earn its render pass:
  // at 0.42 of the key its own shadow is swallowed by the key's light, and in
  // side-by-side captures the crossing shadow it should add is simply not there.
  //
  // `power` is a multiple of FLOOD_CD, `shadow` the map size in texels (0 = this
  // bank does not cast), `blur` the PCF kernel radius, `glow` the fixture's own
  // emissive so the brighter bank reads brighter in the bloom.
  const FLOOD_CD = 1750;
  const poleDefs = [
    { x: -11.2, z: 12.0, rot: 0.5, color: 0xfff1da, power: 1.0, cone: 0.82, shadow: 2048, blur: 2.4, glow: 3.6 },
    { x: 11.2, z: 2.0, rot: -0.5, color: 0xc8dcff, power: 0.42, cone: 0.82, shadow: 0, glow: 2.4 },
    { x: -11.2, z: 2.0, rot: 0.5, color: 0xffe6c0, power: 0.13, cone: 0.7, shadow: 0, glow: 1.2 },
    { x: 11.2, z: 12.0, rot: -0.5, color: 0xd9e8ff, power: 0.13, cone: 0.7, shadow: 0, glow: 1.2 },
  ];
  env.floods = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.55, metalness: 0.75 });
  for (const d of poleDefs) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 7.6, 10), poleMat);
    pole.position.set(d.x, 3.8, d.z);
    pole.castShadow = true;
    scene.add(pole);

    // light bank (2x fixtures angled at court)
    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0x111111, roughness: 0.4, metalness: 0.6,
      emissive: 0xfff2dd, emissiveIntensity: d.glow,
    });
    const bank = new THREE.Group();
    bank.position.set(d.x, 7.4, d.z);
    for (let i = 0; i < 2; i++) {
      const fx = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.32, 0.18), fixtureMat);
      fx.position.set(i === 0 ? -0.34 : 0.34, 0, 0);
      fx.rotation.y = d.rot;
      bank.add(fx);
    }
    scene.add(bank);

    // decay 2 is true inverse-square: it costs a stop of reach across the court
    // but buys the pool-of-light falloff under each bank that sells the height
    // of the poles. The old 1.7 was flattening that out.
    const spot = new THREE.SpotLight(d.color, FLOOD_CD * d.power, 40, d.cone, 0.62, 2);
    spot.position.set(d.x, 7.3, d.z);
    spot.target.position.set(d.x * 0.18, 0, d.z + (d.z < 7 ? 5.0 : -5.0));
    if (d.shadow) {
      spot.castShadow = true;
      spot.shadow.mapSize.set(d.shadow, d.shadow);
      // nothing worth casting sits within 3 m of a bank and the far corner of the
      // court is 24 m out: a tight frustum is free depth precision
      spot.shadow.camera.near = 3;
      spot.shadow.camera.far = 34;
      spot.shadow.bias = -0.0006;
      spot.shadow.normalBias = 0.022;
      spot.shadow.radius = d.blur;
    }
    scene.add(spot);
    scene.add(spot.target);
    env.floods.push({ spot, bank });
  }

  // ---------------- chain-link fence ----------------
  {
    const fenceTex = makeFenceTexture();
    fenceTex.wrapS = fenceTex.wrapT = THREE.RepeatWrapping;
    const fenceMat = new THREE.MeshStandardMaterial({
      map: fenceTex, transparent: true, alphaTest: 0.32,
      side: THREE.DoubleSide, roughness: 0.5, metalness: 0.8,
      color: 0x9aa2ad,
    });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.6, metalness: 0.7 });
    const H = 3.7;
    // objects on the camera-side (z=16.4) line: hidden for the 2K preset so the
    // cage doesn't cross the play area — the rig shoots over/through it.
    env.nearFence = [];
    const NEAR_Z = 16.4;
    const panels = [
      { cx: 0, cz: -2.4, w: 19.5, ry: 0 },
      { cx: 0, cz: 16.4, w: 19.5, ry: 0 },
      { cx: -9.2, cz: 7, w: 19.4, ry: Math.PI / 2 },
      { cx: 9.2, cz: 7, w: 19.4, ry: Math.PI / 2 },
    ];
    for (const p of panels) {
      const tex = fenceTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(p.w / 0.9, H / 0.9);
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(p.w, H),
        new THREE.MeshStandardMaterial({
          map: tex, transparent: true, alphaTest: 0.32, side: THREE.DoubleSide,
          roughness: 0.5, metalness: 0.8, color: 0x9aa2ad,
        })
      );
      m.position.set(p.cx, H / 2, p.cz);
      m.rotation.y = p.ry;
      scene.add(m);
      if (Math.abs(p.cz - NEAR_Z) < 0.01 && p.ry === 0) env.nearFence.push(m);
    }
    // posts every ~3.2m along each panel
    const addPosts = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.round(len / 3.2);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, H + 0.15, 8), postMat);
        post.position.set(x0 + (x1 - x0) * t, (H + 0.15) / 2, z0 + (z1 - z0) * t);
        post.castShadow = true;
        scene.add(post);
        if (Math.abs(post.position.z - NEAR_Z) < 0.01) env.nearFence.push(post);
      }
    };
    addPosts(-9.2, -2.4, 9.2, -2.4);
    addPosts(-9.2, 16.4, 9.2, 16.4);
    addPosts(-9.2, -2.4, -9.2, 16.4);
    addPosts(9.2, -2.4, 9.2, 16.4);

    // top rail
    const railGeo = new THREE.CylinderGeometry(0.035, 0.035, 19.5, 8);
    for (const [x, z, ry] of [[0, -2.4, 0], [0, 16.4, 0], [-9.2, 7, Math.PI / 2], [9.2, 7, Math.PI / 2]]) {
      const rail = new THREE.Mesh(ry === 0 ? railGeo : railGeo.clone(), postMat);
      // cylinder bind axis is +Y: rotate Z to lay it along X (baseline panels),
      // rotate X to lay it along Z (sideline panels). These were swapped, which
      // dropped a rail straight across the court at z=7 — invisible from the old
      // sideline camera, dead centre of frame from the 2K rig.
      if (ry === 0) rail.rotation.z = Math.PI / 2;
      else rail.rotation.x = Math.PI / 2;
      rail.position.set(x, H, z);
      scene.add(rail);
      if (Math.abs(z - NEAR_Z) < 0.01) env.nearFence.push(rail);
    }
  }

  // ---------------- lived-in park details ----------------
  // Keep this one small static group: enough authored landmarks for depth and
  // place identity, without turning the half-court into a prop catalogue.
  {
    const props = new THREE.Group();
    props.name = 'park-details';
    const steel = new THREE.MeshStandardMaterial({ color: 0x252c36, roughness: 0.5, metalness: 0.72 });
    const seat = new THREE.MeshStandardMaterial({ color: 0x364454, roughness: 0.78, metalness: 0.18 });
    const edge = new THREE.MeshStandardMaterial({ color: 0xe46c37, roughness: 0.64 });

    const addBleacher = (cx) => {
      const g = new THREE.Group();
      g.position.set(cx, 0, -3.25);
      for (let row = 0; row < 3; row++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.13, 0.5), row === 2 ? edge : seat);
        plank.position.set(0, 0.36 + row * 0.32, -row * 0.52);
        plank.castShadow = true; plank.receiveShadow = true;
        g.add(plank);
        for (const x of [-1.65, 1.65]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55 + row * 0.32, 0.08), steel);
          leg.position.set(x, (0.55 + row * 0.32) / 2, -row * 0.52);
          leg.castShadow = true;
          g.add(leg);
        }
      }
      props.add(g);
    };
    addBleacher(-5.55);
    addBleacher(5.55);

    const bannerDefs = [
      [-5.15, 'NIGHT RUN', '#ff7a3d', '#181d27'],
      [5.15, 'OWN THE PARK', '#71e3ef', '#12282e'],
    ];
    for (const [x, label, ink, bg] of bannerDefs) {
      const tex = makeSignTexture(label, ink, bg);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(3.15, 1.05),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.72, metalness: 0.02, side: THREE.DoubleSide }),
      );
      sign.position.set(x, 2.15, -2.34);
      props.add(sign);
    }

    // One courtside bench and ball rack make the near sideline read as a place
    // athletes arrived at, while staying outside the collision fence.
    const bench = new THREE.Group();
    for (const y of [0.42, 0.87]) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.12, 0.42), seat);
      plank.position.set(10.15, y, 10.6 + (y > 0.5 ? 0.22 : 0));
      plank.rotation.y = Math.PI / 2;
      plank.castShadow = true;
      bench.add(plank);
    }
    for (const z of [9.2, 12.0]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.08), steel);
      leg.position.set(10.15, 0.4, z);
      bench.add(leg);
    }
    props.add(bench);
    scene.add(props);
    env.parkDetails = props;
  }

  // ---------------- environment map (for PBR reflections) ----------------
  {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size * 2; c.height = size;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#0b1322');
    grad.addColorStop(0.55, '#141d33');
    grad.addColorStop(0.8, '#1c2030');
    grad.addColorStop(1, '#0a0a0c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size * 2, size);
    // light blobs = floodlights
    const blobs = [
      [0.22, 0.42, 26, 'rgba(255,225,180,0.95)'],
      [0.35, 0.45, 20, 'rgba(255,235,205,0.8)'],
      [0.62, 0.43, 26, 'rgba(210,228,255,0.95)'],
      [0.74, 0.46, 20, 'rgba(255,225,180,0.8)'],
      [0.5, 0.2, 40, 'rgba(90,110,170,0.35)'],
    ];
    for (const [x, y, r, col] of blobs) {
      const g2 = ctx.createRadialGradient(x * size * 2, y * size, 2, x * size * 2, y * size, r);
      g2.addColorStop(0, col);
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, size * 2, size);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    env.envMap = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose();
    tex.dispose();
    scene.environment = env.envMap;
    // second ambient term after the hemisphere light — same argument, it was
    // filling the key's shadow side back in
    scene.environmentIntensity = 0.22;
  }

  return env;
}

// ---------------------------------------------------------------- helpers

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWindowTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 128);
  const rand = mulberry32(3);
  for (let y = 4; y < 124; y += 8) {
    for (let x = 4; x < 60; x += 8) {
      if (rand() < 0.34) {
        const warm = rand() < 0.72;
        const b = 0.35 + rand() * 0.65;
        ctx.fillStyle = warm
          ? `rgba(${255 * b | 0},${200 * b | 0},${130 * b | 0},1)`
          : `rgba(${170 * b | 0},${205 * b | 0},${255 * b | 0},1)`;
        ctx.fillRect(x, y, 4, 5);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

function makeFenceTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(200,205,215,0.9)';
  ctx.lineWidth = 2.2;
  // diamond weave
  ctx.beginPath();
  for (let i = -S; i <= S * 2; i += 16) {
    ctx.moveTo(i, 0); ctx.lineTo(i + S, S);
    ctx.moveTo(i, S); ctx.lineTo(i + S, 0);
  }
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeSignTexture(label, ink, bg) {
  const c = document.createElement('canvas');
  c.width = 768; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 14;
  ctx.strokeRect(18, 18, c.width - 36, c.height - 36);
  ctx.fillStyle = ink;
  ctx.font = '900 74px Arial Black, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, c.width / 2, c.height / 2 - 5);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = '700 19px Arial, sans-serif';
  ctx.letterSpacing = '8px';
  ctx.fillText('VIBE BASKETBALL', c.width / 2, c.height - 40);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
