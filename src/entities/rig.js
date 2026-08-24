import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural athlete rig. Bind pose: neutral stance, arms hanging slightly out.
 *
 * Bone local rotations are IDENTITY at bind; child offsets are pure
 * translations. The Animator resets quaternions each frame and re-poses.
 *
 * Wave 2 rebuild. Two things changed:
 *
 * 1. ANATOMY. The body is no longer a pile of uniform capsules. The torso is a
 *    lofted V-taper (shoulders 0.50 m / waist 0.34 m, elliptical sections —
 *    wide in x, narrow in z), limbs are tapered lofts with biceps / quad / calf
 *    bellies and joint volumes, hands are palm+finger blocks, shoes have a
 *    two-tone extruded sole.
 *
 * 2. SKINNING. The old solver picked the top-4 nearest bone segments over the
 *    *whole* skeleton with a 1/d^3 kernel. Near-singular weights made it an
 *    effectively rigid per-vertex assignment, and cloth vertices routinely
 *    snapped to unrelated bones — which is why shorts and jersey visibly tore
 *    apart in close-ups. Now every part declares an anatomical bone allowlist
 *    and the kernel is offset (1/(d+EPS)^POW), so weights blend, never snap.
 */

// absolute joint positions in bind space (world = armature local, feet on y=0)
const J = {
  Hips: [0, 1.04, 0],
  Spine: [0, 1.16, 0],
  Spine1: [0, 1.28, 0],
  Spine2: [0, 1.40, 0],
  Neck: [0, 1.53, 0],
  Head: [0, 1.60, 0],
  HeadTop: [0, 1.82, 0],
  LeftShoulder: [0.045, 1.465, 0],
  LeftArm: [0.205, 1.49, 0],
  LeftForeArm: [0.232, 1.18, 0.022],
  LeftHand: [0.252, 0.905, 0.052],
  LeftHandEnd: [0.256, 0.74, 0.075],
  RightShoulder: [-0.045, 1.465, 0],
  RightArm: [-0.205, 1.49, 0],
  RightForeArm: [-0.232, 1.18, 0.022],
  RightHand: [-0.252, 0.905, 0.052],
  RightHandEnd: [-0.256, 0.74, 0.075],
  LeftUpLeg: [0.115, 0.99, 0],
  LeftLeg: [0.115, 0.53, 0.014],
  LeftFoot: [0.115, 0.095, -0.018],
  LeftToeBase: [0.115, 0.045, 0.13],
  RightUpLeg: [-0.115, 0.99, 0],
  RightLeg: [-0.115, 0.53, 0.014],
  RightFoot: [-0.115, 0.095, -0.018],
  RightToeBase: [-0.115, 0.045, 0.13],
};

const PARENTS = {
  Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};

const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// ---------------------------------------------------------------- bone volumes
// capsule volumes used for skin weighting (bind space)
const SEGMENTS = [
  ['Hips', J.Hips, [0, 1.12, 0], 0.14],
  ['Spine', [0, 1.12, 0], J.Spine1, 0.14],
  ['Spine1', J.Spine1, J.Spine2, 0.15],
  ['Spine2', J.Spine2, [0, 1.50, 0], 0.16],
  ['Neck', [0, 1.50, 0], [0, 1.60, 0], 0.055],
  ['Head', [0, 1.62, 0.005], J.HeadTop, 0.10],
  ['LeftShoulder', [0.05, 1.47, 0], J.LeftArm, 0.06],
  ['RightShoulder', [-0.05, 1.47, 0], J.RightArm, 0.06],
  ['LeftArm', J.LeftArm, J.LeftForeArm, 0.062],
  ['RightArm', J.RightArm, J.RightForeArm, 0.062],
  ['LeftForeArm', J.LeftForeArm, J.LeftHand, 0.05],
  ['RightForeArm', J.RightForeArm, J.RightHand, 0.05],
  ['LeftHand', J.LeftHand, J.LeftHandEnd, 0.04],
  ['RightHand', J.RightHand, J.RightHandEnd, 0.04],
  ['LeftUpLeg', [0.115, 1.0, 0], J.LeftLeg, 0.095],
  ['RightUpLeg', [-0.115, 1.0, 0], J.RightLeg, 0.095],
  ['LeftLeg', J.LeftLeg, J.LeftFoot, 0.062],
  ['RightLeg', J.RightLeg, J.RightFoot, 0.062],
  ['LeftFoot', [0.115, 0.06, -0.09], J.LeftToeBase, 0.045],
  ['RightFoot', [-0.115, 0.06, -0.09], J.RightToeBase, 0.045],
  ['LeftToeBase', J.LeftToeBase, [0.115, 0.035, 0.20], 0.04],
  ['RightToeBase', J.RightToeBase, [-0.115, 0.035, 0.20], 0.04],
].map(([bone, a, b, r]) => ({ bone, a: v(a), b: v(b), r }));

// anatomical bone allowlists per body part
const ALLOW = {
  torso: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder'],
  head: ['Head', 'Neck'],
  seat: ['Hips', 'LeftUpLeg', 'RightUpLeg', 'Spine'],
  armL: ['Spine2', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'],
  armR: ['Spine2', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'],
  handL: ['LeftForeArm', 'LeftHand'],
  handR: ['RightForeArm', 'RightHand'],
  legL: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'],
  legR: ['Hips', 'RightUpLeg', 'RightLeg', 'RightFoot'],
  shortL: ['Hips', 'LeftUpLeg'],
  shortR: ['Hips', 'RightUpLeg'],
  footL: ['LeftLeg', 'LeftFoot', 'LeftToeBase'],
  footR: ['RightLeg', 'RightFoot', 'RightToeBase'],
};

// ---------------------------------------------------------------- torso profiles
// [y, rx, rz, cz] — elliptical rings, x wide / z narrow.
// Shoulder 2*rx = 0.50, waist 2*rx = 0.34.
const TORSO_SKIN = [
  [0.905, 0.150, 0.108, 0.000],
  [0.960, 0.166, 0.118, 0.000],
  [1.030, 0.176, 0.121, 0.002],
  [1.100, 0.172, 0.112, 0.004],
  [1.150, 0.170, 0.106, 0.004],   // waist 0.34
  [1.220, 0.184, 0.114, 0.006],
  [1.290, 0.206, 0.126, 0.008],
  [1.355, 0.224, 0.134, 0.010],   // chest
  [1.420, 0.240, 0.130, 0.006],
  [1.472, 0.248, 0.118, 0.000],   // shoulder line 0.50
  [1.510, 0.196, 0.100, -0.004],  // trapezius slope
  [1.540, 0.120, 0.078, -0.006],
];

const TORSO_JERSEY = [
  [1.040, 0.212, 0.152, 0.004],   // flared hem
  [1.075, 0.192, 0.131, 0.004],
  [1.140, 0.183, 0.118, 0.005],
  [1.220, 0.196, 0.125, 0.007],
  [1.290, 0.217, 0.137, 0.009],
  [1.355, 0.235, 0.145, 0.011],
  [1.420, 0.250, 0.141, 0.007],
  [1.468, 0.256, 0.129, 0.001],
];

const SEAT_SHORTS = [
  [1.074, 0.183, 0.126, 0.004],   // waistband
  [1.040, 0.187, 0.132, 0.004],
  [0.980, 0.194, 0.142, 0.002],
  [0.930, 0.194, 0.144, 0.000],
  [0.896, 0.190, 0.140, 0.000],
];

export class Rig {
  constructor(config = {}) {
    this.config = config;
    this.group = new THREE.Group();       // player root: position on floor, yaw = facing
    this.armature = new THREE.Group();
    this.group.add(this.armature);

    // ---- build bones ----
    this.bones = {};
    this.boneList = [];
    for (const name of Object.keys(PARENTS)) {
      const bone = new THREE.Bone();
      bone.name = name;
      this.bones[name] = bone;
      this.boneList.push(bone);
    }
    for (const [name, parent] of Object.entries(PARENTS)) {
      const bone = this.bones[name];
      const worldPos = v(J[name]);
      if (parent) {
        this.bones[parent].add(bone);
        bone.position.copy(worldPos.clone().sub(v(J[parent])));
      } else {
        this.armature.add(bone);
        bone.position.copy(worldPos);
      }
    }
    const boneIndex = {};
    this.boneList.forEach((b, i) => boneIndex[b.name] = i);
    this.segments = SEGMENTS;

    // ---- geometry buckets (one merged skinned mesh per material) ----
    const skin = [], jersey = [], shorts = [], shoes = [], sole = [], hair = [], trim = [];
    const put = (bucket, geo, allow) => {
      bake(geo, SEGMENTS, boneIndex, allow);
      bucket.push(geo);
    };

    // ---------------------------------------------------------- torso
    put(skin, ringLoft(TORSO_SKIN), ALLOW.torso);
    // pectoral shelf reads as chest volume in silhouette
    put(skin, ellipsoid([0.072, 1.352, 0.104], [0.082, 0.052, 0.046]), ALLOW.torso);
    put(skin, ellipsoid([-0.072, 1.352, 0.104], [0.082, 0.052, 0.046]), ALLOW.torso);
    // trapezius slope neck -> shoulder
    put(skin, limbTube([0.030, 1.520, -0.010], [0.170, 1.484, -0.004],
      [[0, 0.052], [0.5, 0.062], [1, 0.052]], { round: true }), ALLOW.torso);
    put(skin, limbTube([-0.030, 1.520, -0.010], [-0.170, 1.484, -0.004],
      [[0, 0.052], [0.5, 0.062], [1, 0.052]], { round: true }), ALLOW.torso);
    // neck
    put(skin, limbTube([0, 1.478, 0.006], [0, 1.605, 0.004],
      [[0, 0.072], [0.45, 0.058], [1, 0.056]]), ALLOW.torso);

    // ---------------------------------------------------------- head
    this.buildHead(put, skin, hair, trim);

    // ---------------------------------------------------------- arms + legs
    for (const side of ['Left', 'Right']) {
      const s = side === 'Left' ? 1 : -1;
      const A = ALLOW[side === 'Left' ? 'armL' : 'armR'];
      const H = ALLOW[side === 'Left' ? 'handL' : 'handR'];
      const L = ALLOW[side === 'Left' ? 'legL' : 'legR'];
      const SH = ALLOW[side === 'Left' ? 'shortL' : 'shortR'];
      const F = ALLOW[side === 'Left' ? 'footL' : 'footR'];

      // deltoid cap
      put(skin, ellipsoid([s * 0.202, 1.482, 0.004], [0.080, 0.084, 0.079]), A);
      // upper arm: taper + biceps belly (forward bulge via cz)
      put(skin, limbTube(J[`${side}Arm`], J[`${side}ForeArm`], [
        [0.00, 0.070, 0.070, 0.000],
        [0.28, 0.077, 0.074, 0.014],   // biceps
        [0.55, 0.067, 0.064, 0.009],
        [1.00, 0.052, 0.052, 0.000],
      ], { round: 'end' }), A);
      // elbow
      put(skin, ellipsoid(J[`${side}ForeArm`], [0.055, 0.055, 0.055]), A);
      // forearm: brachioradialis swell then thin wrist
      put(skin, limbTube(J[`${side}ForeArm`], J[`${side}Hand`], [
        [0.00, 0.053, 0.053, 0.000],
        [0.22, 0.059, 0.057, 0.005],
        [0.70, 0.042, 0.041, 0.000],
        [1.00, 0.033, 0.032, 0.000],
      ], { round: 'end' }), A);
      // hand: palm slab (wide in z, thin in x) + closed finger block + thumb
      put(skin, limbTube(J[`${side}Hand`], midPt(J[`${side}Hand`], J[`${side}HandEnd`], 0.62), [
        [0.00, 0.029, 0.040],
        [0.30, 0.033, 0.052],
        [1.00, 0.032, 0.055],
      ], { round: 'none' }), H);
      put(skin, limbTube(midPt(J[`${side}Hand`], J[`${side}HandEnd`], 0.60), J[`${side}HandEnd`], [
        [0.00, 0.031, 0.054],
        [0.65, 0.030, 0.052],
        [1.00, 0.024, 0.040],
      ], { round: 'end' }), H);
      put(skin, limbTube(
        [s * 0.236, 0.878, 0.086], [s * 0.230, 0.812, 0.106],
        [[0, 0.020], [0.5, 0.021], [1, 0.017]], { round: true }), H);

      // ---- leg ----
      // quadriceps: thick at hip, belly forward, narrowing into the knee
      put(skin, limbTube([s * 0.117, 1.000, 0.004], J[`${side}Leg`], [
        [0.00, 0.108, 0.108, 0.000],
        [0.30, 0.106, 0.109, 0.015],
        [0.62, 0.093, 0.095, 0.010],
        [1.00, 0.070, 0.070, 0.000],
      ], { round: 'none' }), L);
      // knee ball + patella
      put(skin, ellipsoid(J[`${side}Leg`], [0.068, 0.068, 0.066]), L);
      put(skin, ellipsoid([s * 0.115, 0.523, 0.042], [0.041, 0.046, 0.026]), L);
      // calf: gastrocnemius belly behind, thin ankle
      put(skin, limbTube(J[`${side}Leg`], [s * 0.115, 0.108, -0.014], [
        [0.00, 0.068, 0.068, 0.000],
        [0.26, 0.079, 0.081, -0.020],
        [0.62, 0.055, 0.058, -0.009],
        [1.00, 0.038, 0.040, 0.000],
      ], { round: 'none' }), L);
      // ankle bones
      put(skin, ellipsoid([s * 0.115, 0.120, -0.010], [0.038, 0.036, 0.040]), L);

      // ---- shorts leg (opening clearly wider than the thigh) ----
      put(shorts, limbTube([s * 0.120, 0.958, 0.004], [s * 0.124, 0.672, 0.006], [
        [0.00, 0.128, 0.132, 0.000],
        [0.45, 0.120, 0.126, 0.005],
        [0.88, 0.121, 0.127, 0.007],
        [1.00, 0.124, 0.130, 0.007],
      ], { round: 'none', open: true }), SH);

      // ---- sock ----
      put(trim, limbTube([s * 0.115, 0.300, 0.000], [s * 0.115, 0.128, -0.012], [
        [0.00, 0.058, 0.060],
        [0.70, 0.050, 0.052],
        [1.00, 0.046, 0.048],
      ], { round: 'none' }), F);

      // ---- shoe: extruded two-tone sole stack + upper + collar ----
      put(sole, shoeSlab(s, 0.004, 0.026, 1.00), F);
      put(shoes, shoeSlab(s, 0.026, 0.049, 0.985), F);
      put(sole, shoeSlab(s, 0.049, 0.062, 0.95), F);
      put(shoes, shoeUpper(s), F);
      put(trim, torus([s * 0.115, 0.152, -0.030], 0.052, 0.010, [1, 1, 1.05]), F);
    }

    // ---------------------------------------------------------- jersey
    put(jersey, ringLoft(TORSO_JERSEY), ALLOW.torso);
    // shoulder straps: jersey rides the trapezius onto the deltoid
    put(jersey, limbTube([0.086, 1.474, 0.014], [0.196, 1.470, -0.004],
      [[0, 0.060], [0.55, 0.056], [1, 0.048]], { round: 'none' }), ALLOW.torso);
    put(jersey, limbTube([-0.086, 1.474, 0.014], [-0.196, 1.470, -0.004],
      [[0, 0.060], [0.55, 0.056], [1, 0.048]], { round: 'none' }), ALLOW.torso);
    put(jersey, torus([0, 1.487, 0.004], 0.086, 0.016, [1.02, 0.5, 0.86]), ALLOW.torso);

    // ---------------------------------------------------------- shorts seat
    put(shorts, ringLoft(SEAT_SHORTS, { capTop: false, capBottom: false }), ALLOW.seat);
    put(trim, torus([0, 1.076, 0.004], 0.184, 0.013, [1, 0.55, 0.69]), ALLOW.seat);

    // ---------------------------------------------------------- skeleton
    // The bind pose must be baked from *updated* world matrices. Constructing a
    // Skeleton before armature.updateMatrixWorld() leaves every boneInverse an
    // identity matrix, so at render time each vertex gets translated by its own
    // joint position on top of the pose — which is what tore the Wave 1 athlete
    // into floating, over-long limbs. Compute the inverses explicitly and pass
    // an explicit bindMatrix so SkinnedMesh.bind() can't recompute them.
    this.armature.updateMatrixWorld(true);
    const boneInverses = this.boneList.map(
      (b) => new THREE.Matrix4().copy(b.matrixWorld).invert()
    );
    this.skeleton = new THREE.Skeleton(this.boneList, boneInverses);
    const BIND_MATRIX = new THREE.Matrix4();

    const cfg = {
      skin: config.skin ?? 0x8a5c3a,
      jersey: config.jersey ?? 0x23262c,
      shorts: config.shorts ?? 0x1d5a5e,
      shoes: config.shoes ?? 0xd8551f,
      hair: config.hair ?? 0x17110b,
      number: config.number ?? 7,
      numberColor: config.numberColor ?? '#f2f4f6',
    };
    this.teamColor = new THREE.Color(cfg.shorts);

    const mk = (geos, mat) => {
      const merged = mergeGeometries(geos, false);
      const mesh = new THREE.SkinnedMesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.bind(this.skeleton, BIND_MATRIX);
      this.armature.add(mesh);
      return mesh;
    };

    const skinNoise = noiseNormalMap(12, 0.55);
    const clothNoise = noiseNormalMap(5, 0.5);

    this.meshSkin = mk(skin, new THREE.MeshStandardMaterial({
      color: cfg.skin, roughness: 0.58, metalness: 0.0,
      normalMap: skinNoise, normalScale: new THREE.Vector2(0.22, 0.22),
    }));
    this.meshJersey = mk(jersey, new THREE.MeshPhysicalMaterial({
      color: cfg.jersey, roughness: 0.86, metalness: 0.0,
      normalMap: clothNoise, normalScale: new THREE.Vector2(0.28, 0.28),
      sheen: 0.2, sheenRoughness: 0.9, sheenColor: new THREE.Color(0x8b95a4),
    }));
    this.meshShorts = mk(shorts, new THREE.MeshPhysicalMaterial({
      color: cfg.shorts, roughness: 0.88, metalness: 0.0,
      normalMap: clothNoise, normalScale: new THREE.Vector2(0.26, 0.26),
      sheen: 0.18, sheenRoughness: 0.9, sheenColor: new THREE.Color(0x8b95a4),
    }));
    this.meshShoes = mk(shoes, new THREE.MeshStandardMaterial({
      color: cfg.shoes, roughness: 0.5, metalness: 0.05,
    }));
    this.meshSole = mk(sole, new THREE.MeshStandardMaterial({
      color: 0xd8dde3, roughness: 0.72, metalness: 0.0,
    }));
    this.meshHair = mk(hair, new THREE.MeshStandardMaterial({
      color: cfg.hair, roughness: 0.95, metalness: 0.0,
    }));
    this.meshTrim = mk(trim, new THREE.MeshStandardMaterial({
      color: 0xc6ccd4, roughness: 0.86, metalness: 0.0,
    }));

    // jersey number (front + back), skinned to chest
    {
      const numTex = makeNumberTexture(cfg.number, cfg.numberColor);
      const numMat = new THREE.MeshStandardMaterial({
        map: numTex, transparent: true, roughness: 0.85,
        polygonOffset: true, polygonOffsetFactor: -2,
      });
      const idx = boneIndex.Spine2;
      const mkNum = (back, z) => {
        const g = new THREE.PlaneGeometry(0.25, 0.28);
        g.translate(0, 1.335, z);
        if (back) g.rotateY(Math.PI);
        const si = new Uint16Array(g.attributes.position.count * 4);
        const sw = new Float32Array(g.attributes.position.count * 4);
        for (let i = 0; i < g.attributes.position.count; i++) { si[i * 4] = idx; sw[i * 4] = 1; }
        g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
        g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
        const m = new THREE.SkinnedMesh(g, numMat);
        m.castShadow = false;
        m.frustumCulled = false;
        m.bind(this.skeleton, BIND_MATRIX);
        this.armature.add(m);
      };
      mkNum(false, 0.156);
      mkNum(true, -0.152);
    }

    // ---------------------------------------------------------- ground contact
    // Soft elliptical contact shadow that fades with air time — kills the
    // "floating" read, and being plain geometry it survives ?lite=1 where the
    // shadow map is off. Lives in world space (the rig group rises on jumps).
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 28),
      new THREE.MeshBasicMaterial({
        map: contactShadowTexture(), transparent: true, opacity: 0.5,
        depthWrite: false, color: 0x000000,
      })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.scale.set(1, 0.74, 1);
    this.shadow.renderOrder = 1;

    // user indicator ring (team colour, breathing) — enabled by Player
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.40, 0.50, 40),
      new THREE.MeshBasicMaterial({
        color: this.teamColor, transparent: true, opacity: 0.75,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.scale.set(1, 0.76, 1);
    this.ring.renderOrder = 2;
    this.ring.visible = false;

    // rest-pose world data for IK
    this.rest = {};
    this.armature.updateMatrixWorld(true);
    for (const name of Object.keys(this.bones)) {
      const b = this.bones[name];
      const pos = new THREE.Vector3();
      b.getWorldPosition(pos);
      this.rest[name] = { pos };
    }
    for (const side of ['Left', 'Right']) {
      const S = this.rest[`${side}Arm`].pos, E = this.rest[`${side}ForeArm`].pos, W = this.rest[`${side}Hand`].pos;
      this[`${side}L1`] = S.distanceTo(E);
      this[`${side}L2`] = E.distanceTo(W);
      this[`${side}BindUpper`] = E.clone().sub(S).normalize();
      this[`${side}BindFore`] = W.clone().sub(E).normalize();
      this[`${side}BindHand`] = v(J[`${side}HandEnd`]).sub(W).normalize();
    }

    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._m1 = new THREE.Matrix4();
    this._vA = new THREE.Vector3();
    this._vB = new THREE.Vector3();
    this._vC = new THREE.Vector3();
    this._vD = new THREE.Vector3();
    this._ringT = Math.random() * 6;
  }

  // ---------------------------------------------------------------- head
  buildHead(put, skin, hair, trim) {
    // cranium: occiput volume behind, jaw narrowing in front
    put(skin, ringLoft([
      [1.588, 0.062, 0.060, 0.004],   // throat / under jaw
      [1.618, 0.078, 0.082, 0.012],   // jawline
      [1.648, 0.089, 0.095, 0.008],   // cheek
      [1.686, 0.096, 0.104, 0.000],   // eye line
      [1.724, 0.097, 0.104, -0.006],  // brow
      [1.762, 0.092, 0.097, -0.012],  // upper skull
      [1.796, 0.070, 0.072, -0.016],
      [1.818, 0.032, 0.033, -0.016],
    ], { capBottom: false }), ALLOW.head);
    // chin block, narrower than the cheeks — the jaw taper reads at distance
    put(skin, ellipsoid([0, 1.612, 0.070], [0.048, 0.036, 0.038]), ALLOW.head);
    // occiput
    put(skin, ellipsoid([0, 1.716, -0.052], [0.086, 0.084, 0.062]), ALLOW.head);
    // ears
    put(skin, ellipsoid([0.096, 1.686, -0.008], [0.016, 0.030, 0.024]), ALLOW.head);
    put(skin, ellipsoid([-0.096, 1.686, -0.008], [0.016, 0.030, 0.024]), ALLOW.head);
    // brow ridge
    put(skin, limbTube([0.070, 1.722, 0.072], [-0.070, 1.722, 0.072],
      [[0, 0.012], [0.5, 0.016], [1, 0.012]], { round: true }), ALLOW.head);
    // nose
    put(skin, limbTube([0, 1.700, 0.086], [0, 1.658, 0.104],
      [[0, 0.011], [1, 0.017]], { round: true }), ALLOW.head);
    // eyes
    put(hair, ellipsoid([0.040, 1.694, 0.092], [0.014, 0.011, 0.010]), ALLOW.head);
    put(hair, ellipsoid([-0.040, 1.694, 0.092], [0.014, 0.011, 0.010]), ALLOW.head);
    // solid hair volume: a skull cap that sits ON the head, not a decal
    put(hair, ringLoft([
      [1.700, 0.101, 0.108, -0.004],
      [1.734, 0.104, 0.110, -0.008],
      [1.772, 0.100, 0.104, -0.014],
      [1.806, 0.076, 0.078, -0.018],
      [1.828, 0.030, 0.031, -0.018],
    ], { capBottom: false }), ALLOW.head);
    // fade / hairline at the temples
    put(hair, ringLoft([
      [1.678, 0.099, 0.100, -0.010],
      [1.702, 0.103, 0.108, -0.008],
    ], { capTop: false, capBottom: false }), ALLOW.head);
    // thick headband
    put(trim, torus([0, 1.736, 0.000], 0.100, 0.026, [1.0, 1.0, 1.06]), ALLOW.head);
  }

  /** reset all bones to bind */
  handPosition(side, out) {
    const b = this.bones[side === 'Left' ? 'LeftHand' : 'RightHand'];
    if (!b) return out.set(0, 1, 0);
    this.armature.updateMatrixWorld(true);
    return out.setFromMatrixPosition(b.matrixWorld);
  }
  /** palm anchor — the procedural rig's hand bone is already at the palm */
  palmPosition(side, out) {
    return this.handPosition(side, out);
  }


  resetPose() {
    for (const b of this.boneList) b.quaternion.identity();
    this.bones.Hips.position.set(0, 1.04, 0);
  }

  // ---- pose API (all values are RELATIVE TO BIND) ----

  setBoneEuler(name, x, y, z, w = 1) {
    const b = this.bones[name];
    if (!b) return;
    if (w >= 1) {
      b.rotation.set(x, y, z);
    } else {
      _euler.set(x, y, z);
      _quat.setFromEuler(_euler);
      b.quaternion.slerp(_quat, w);
    }
  }

  addBoneEuler(name, x, y, z) {
    const b = this.bones[name];
    if (!b) return;
    b.rotation.x += x; b.rotation.y += y; b.rotation.z += z;
  }

  /** hips displacement from bind, in metres */
  setHipsOffset(dy, dx = 0) {
    this.bones.Hips.position.set(dx, 1.04 + dy, 0);
  }

  addHipsOffset(dy, dx = 0) {
    this.bones.Hips.position.y += dy;
    this.bones.Hips.position.x += dx;
  }

  /** ground props: contact shadow + optional indicator ring */
  updateGround(dt, x, z, airY) {
    const fade = Math.max(0, 1 - airY * 0.55);
    const grow = 1 + airY * 0.22;
    this.shadow.position.set(x, 0.012, z);
    this.shadow.scale.set(grow, 0.74 * grow, 1);
    this.shadow.material.opacity = 0.06 + 0.46 * fade * fade;
    if (this.ring.visible) {
      this._ringT += dt;
      const b = 0.5 + 0.5 * Math.sin(this._ringT * 2.4);
      this.ring.position.set(x, 0.018, z);
      const s = 1 + b * 0.07;
      this.ring.scale.set(s, 0.76 * s, 1);
      this.ring.material.opacity = (0.34 + 0.34 * b) * Math.max(0.12, fade);
    }
  }

  boneWorldPos(name, out = new THREE.Vector3()) {
    return this.bones[name].getWorldPosition(out);
  }

  /**
   * Two-bone analytic IK for an arm, rotation-transfer style (minimal twist).
   * target: world position for the WRIST. pole: world dir hint for elbow.
   */
  solveArmIK(side, target, pole, weight = 1) {
    const L1 = this[`${side}L1`], L2 = this[`${side}L2`];
    const upperBone = this.bones[`${side}Arm`];
    const foreBone = this.bones[`${side}ForeArm`];
    upperBone.updateWorldMatrix(true, false);
    const S = this._vA.setFromMatrixPosition(upperBone.matrixWorld);

    const dir = this._vB.copy(target).sub(S);
    let d = dir.length();
    const maxD = (L1 + L2) * 0.998, minD = Math.abs(L1 - L2) + 0.02;
    d = THREE.MathUtils.clamp(d, minD, maxD);
    dir.normalize();

    const a = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - (a * L1) ** 2));
    const poleDir = this._vC.copy(pole).sub(S).normalize();
    const perp = poleDir.clone().addScaledVector(dir, -poleDir.dot(dir));
    if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1).addScaledVector(dir, -dir.z);
    perp.normalize();
    const E = S.clone().addScaledVector(dir, a * L1).addScaledVector(perp, h);

    const upperDir = E.clone().sub(S).normalize();
    const foreDir = this._vD.copy(target).sub(E).normalize();

    this.setBoneWorldDir(upperBone, this[`${side}BindUpper`], upperDir, weight);
    this.setBoneWorldDir(foreBone, this[`${side}BindFore`], foreDir, weight);
  }

  /** rotate bone so that its bind-space direction points along desired world dir */
  setBoneWorldDir(bone, bindDirWorld, desiredDirWorld, weight = 1) {
    const qWorld = this._q1.setFromUnitVectors(bindDirWorld, desiredDirWorld);
    const parent = bone.parent;
    parent.getWorldQuaternion(this._q2);
    const qLocal = this._q2.clone().invert().multiply(qWorld);
    if (weight < 1) bone.quaternion.slerp(qLocal, weight);
    else bone.quaternion.copy(qLocal);
    bone.updateWorldMatrix(true, false);
  }

  /** rotate hand to aim fingers along desired world dir */
  aimHand(side, dirWorld, weight = 1) {
    this.setBoneWorldDir(this.bones[`${side}Hand`], this[`${side}BindHand`], dirWorld, weight);
  }
}

// ---------------------------------------------------------------- geometry helpers

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Loft a closed tube through horizontal elliptical rings.
 * rings: [y, rx, rz, cz?]  (cx is always 0)
 */
function ringLoft(rings, { N = 22, capTop = true, capBottom = true } = {}) {
  const R = rings.length;
  const pos = [], uv = [], idx = [];
  for (let r = 0; r < R; r++) {
    const [y, rx, rz, cz = 0] = rings[r];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pos.push(Math.cos(a) * rx, y, cz + Math.sin(a) * rz);
      uv.push(i / N, r / (R - 1));
    }
  }
  for (let r = 0; r < R - 1; r++) {
    for (let i = 0; i < N; i++) {
      const A = r * (N + 1) + i, B = A + 1, C = A + N + 1, D = C + 1;
      idx.push(A, C, B, B, C, D);
    }
  }
  if (capTop) fanCap(pos, uv, idx, rings[R - 1], N, true);
  if (capBottom) fanCap(pos, uv, idx, rings[0], N, false);
  return finish(pos, uv, idx);
}

function fanCap(pos, uv, idx, ring, N, top) {
  const [y, rx, rz, cz = 0] = ring;
  const centre = pos.length / 3;
  pos.push(0, y, cz); uv.push(0.5, top ? 1 : 0);
  const base = pos.length / 3;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    pos.push(Math.cos(a) * rx, y, cz + Math.sin(a) * rz);
    uv.push(i / N, top ? 1 : 0);
  }
  for (let i = 0; i < N; i++) {
    if (top) idx.push(centre, base + i, base + i + 1);
    else idx.push(centre, base + i + 1, base + i);
  }
}

/**
 * Tapered tube between two points. profile entries: [t, r] | [t, rx, rz] |
 * [t, rx, rz, offset], where offset shifts the ring along local +Z — that is
 * what gives biceps / quad / calf their bellies.
 * round: true (both ends) | 'end' | 'none'
 */
function limbTube(a, b, profile, { N = 16, round = true, open = false } = {}) {
  const A = v(a), B = v(b);
  const len = Math.max(1e-4, A.distanceTo(B));
  const dir = B.clone().sub(A).normalize();
  const rows = [];
  const at = (t) => {
    let i = 0;
    while (i < profile.length - 2 && profile[i + 1][0] < t) i++;
    const p0 = profile[i], p1 = profile[Math.min(i + 1, profile.length - 1)];
    const span = Math.max(1e-6, p1[0] - p0[0]);
    const k = Math.min(1, Math.max(0, (t - p0[0]) / span));
    const g = (p, j, d) => (p[j] ?? d);
    const rx0 = g(p0, 1, 0.05), rx1 = g(p1, 1, 0.05);
    const rz0 = g(p0, 2, rx0), rz1 = g(p1, 2, rx1);
    return {
      rx: rx0 + (rx1 - rx0) * k,
      rz: rz0 + (rz1 - rz0) * k,
      cz: g(p0, 3, 0) + (g(p1, 3, 0) - g(p0, 3, 0)) * k,
    };
  };
  const STEPS = 10;
  const roundStart = round === true;
  const roundEnd = round === true || round === 'end';
  if (roundStart) {
    const p = at(0);
    for (let k = 3; k >= 1; k--) {
      const q = (k / 4) * Math.PI * 0.5;
      rows.push({ y: -p.rx * Math.cos(q) * 0.9, rx: p.rx * Math.sin(q), rz: p.rz * Math.sin(q), cz: p.cz });
    }
  }
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const p = at(t);
    rows.push({ y: t * len, rx: p.rx, rz: p.rz, cz: p.cz });
  }
  if (roundEnd) {
    const p = at(1);
    for (let k = 3; k >= 1; k--) {
      const q = (k / 4) * Math.PI * 0.5;
      rows.push({ y: len + p.rx * Math.cos(q) * 0.9, rx: p.rx * Math.sin(q), rz: p.rz * Math.sin(q), cz: p.cz });
    }
  }

  const pos = [], uv = [], idx = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      pos.push(Math.cos(ang) * row.rx, row.y, row.cz + Math.sin(ang) * row.rz);
      uv.push(i / N, r / (rows.length - 1));
    }
  }
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < N; i++) {
      const A2 = r * (N + 1) + i, B2 = A2 + 1, C2 = A2 + N + 1, D2 = C2 + 1;
      idx.push(A2, C2, B2, B2, C2, D2);
    }
  }
  if (!open) {
    const last = rows[rows.length - 1], first = rows[0];
    fanCap(pos, uv, idx, [last.y, last.rx, last.rz, last.cz], N, true);
    fanCap(pos, uv, idx, [first.y, first.rx, first.rz, first.cz], N, false);
  }

  const geo = finish(pos, uv, idx);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  geo.applyMatrix4(new THREE.Matrix4().compose(A, q, ONE));
  return geo;
}

function ellipsoid(c, r, seg = 14) {
  const C = v(c);
  const g = new THREE.SphereGeometry(1, seg, Math.max(8, seg - 4));
  g.scale(r[0], r[1], r[2]);
  g.translate(C.x, C.y, C.z);
  return g;
}

function torus(c, radius, tube, scale = [1, 1, 1]) {
  const g = new THREE.TorusGeometry(radius, tube, 8, 26);
  g.rotateX(Math.PI / 2);
  g.scale(scale[0], scale[1], scale[2]);
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** one horizontal slab of a shoe sole (footprint outline, extruded) */
function shoeSlab(s, y0, y1, shrink) {
  const outline = [
    [0.000, 0.215], [0.036, 0.198], [0.052, 0.150], [0.056, 0.070],
    [0.052, -0.010], [0.048, -0.075], [0.036, -0.112], [0.000, -0.122],
    [-0.036, -0.112], [-0.050, -0.075], [-0.054, -0.010], [-0.052, 0.070],
    [-0.048, 0.150], [-0.032, 0.198],
  ];
  const pos = [], uv = [], idx = [];
  const N = outline.length;
  const P = (i, y) => {
    const [x, z] = outline[i];
    pos.push(s * 0.115 + x * shrink, y, 0.035 + z * shrink);
    uv.push(i / N, y);
  };
  for (let i = 0; i < N; i++) P(i, y0);
  for (let i = 0; i < N; i++) P(i, y1);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(i, i + N, j, j, i + N, j + N);
  }
  const cTop = pos.length / 3; pos.push(s * 0.115, y1, 0.035); uv.push(0.5, 1);
  const cBot = pos.length / 3; pos.push(s * 0.115, y0, 0.035); uv.push(0.5, 0);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(cTop, i + N, j + N);
    idx.push(cBot, j, i);
  }
  return finish(pos, uv, idx);
}

/** shoe upper: rounded vamp + heel counter over the sole stack */
function shoeUpper(s) {
  const g = new THREE.SphereGeometry(1, 16, 12);
  g.scale(0.055, 0.052, 0.135);
  g.translate(s * 0.115, 0.062, 0.055);
  const g2 = new THREE.SphereGeometry(1, 14, 10);
  g2.scale(0.050, 0.048, 0.058);
  g2.translate(s * 0.115, 0.082, -0.040);
  return mergeGeometries([g, g2], false);
}

function midPt(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function finish(pos, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- skinning

/**
 * Skin one part against its anatomical bone allowlist.
 *
 * The kernel is 1/(d+EPS)^POW with EPS well above zero: unlike the old 1/d^3
 * solver this never approaches a hard per-vertex assignment, so parts bend
 * across joints instead of tearing.
 */
const EPS = 0.035, POW = 2.6;

function bake(geo, segments, boneIndex, allowNames) {
  const allow = segments.filter((s) => allowNames.includes(s.bone));
  const pos = geo.attributes.position;
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const P = new THREE.Vector3(), AB = new THREE.Vector3(), AP = new THREE.Vector3(), C = new THREE.Vector3();
  const infl = [];

  for (let i = 0; i < count; i++) {
    P.fromBufferAttribute(pos, i);
    infl.length = 0;
    for (const seg of allow) {
      AB.subVectors(seg.b, seg.a);
      AP.subVectors(P, seg.a);
      const t = THREE.MathUtils.clamp(AP.dot(AB) / Math.max(1e-8, AB.lengthSq()), 0, 1);
      C.copy(seg.a).addScaledVector(AB, t);
      const d = Math.max(0, P.distanceTo(C) - seg.r);
      infl.push([boneIndex[seg.bone], 1 / Math.pow(d + EPS, POW)]);
    }
    infl.sort((x, y) => y[1] - x[1]);
    const n = Math.min(4, infl.length);
    let wsum = 0;
    for (let k = 0; k < n; k++) wsum += infl[k][1];
    for (let k = 0; k < 4; k++) {
      if (k < n) {
        skinIndex[i * 4 + k] = infl[k][0];
        skinWeight[i * 4 + k] = infl[k][1] / wsum;
      } else {
        skinIndex[i * 4 + k] = infl[0][0];
        skinWeight[i * 4 + k] = 0;
      }
    }
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return geo;
}

// ---------------------------------------------------------------- textures

function makeNumberTexture(number, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 288;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 256, 288);
  ctx.fillStyle = color;
  ctx.font = '900 210px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(String(number), 128, 150);
  ctx.fillText(String(number), 128, 150);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const _noiseCache = {};
/** cheap value-noise normal map — fabric weave / skin micro-detail */
function noiseNormalMap(scale, strength) {
  const key = `${scale}_${strength}`;
  if (_noiseCache[key]) return _noiseCache[key];
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) h[i] = Math.random();
  const blur = () => {
    const o = Float32Array.from(h);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let a = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        a += o[((y + dy + S) % S) * S + ((x + dx + S) % S)];
      h[y * S + x] = a / 9;
    }
  };
  blur(); blur();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const gx = (h[y * S + (x + 1) % S] - h[y * S + (x - 1 + S) % S]) * strength * 6;
    const gy = (h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x]) * strength * 6;
    const i = (y * S + x) * 4;
    img.data[i] = Math.max(0, Math.min(255, 128 - gx * 127));
    img.data[i + 1] = Math.max(0, Math.min(255, 128 - gy * 127));
    img.data[i + 2] = 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(scale, scale);
  _noiseCache[key] = t;
  return t;
}

let _shadowTex = null;
function contactShadowTexture() {
  if (_shadowTex) return _shadowTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.95)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

export { J as BIND_JOINTS, contactShadowTexture };
