import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { COURT } from './court.js';
import { STATIONS, buildAttemptSequence } from '../game/threePointRules.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
export const SHOOTER_LINE_CLEARANCE = 0.45;

function spot(id, x, z, kind = 'rack') {
  const position = new THREE.Vector3(x, 0, z);
  const outward = position.clone().sub(new THREE.Vector3(COURT.rimCenter.x, 0, COURT.rimCenter.z)).normalize();
  const tangent = new THREE.Vector3(-outward.z, 0, outward.x);
  const side = x <= 0 ? -1 : 1;
  const propPosition = position.clone()
    .addScaledVector(outward, kind === 'logo' ? 0.52 : 0.30)
    .addScaledVector(tangent, kind === 'logo' ? side * 0.62 : side * 1.35);
  const facing = Math.atan2(COURT.rimCenter.x - x, COURT.rimCenter.z - z);
  return Object.freeze({ id, kind, position, propPosition, facing, propRotation: facing });
}

function behindArc(id, x, z) {
  const line = new THREE.Vector3(x, 0, z);
  const outward = line.clone()
    .sub(new THREE.Vector3(COURT.rimCenter.x, 0, COURT.rimCenter.z))
    .normalize();
  line.addScaledVector(outward, SHOOTER_LINE_CLEARANCE);
  return spot(id, line.x, line.z);
}

function behindCorner(id, side, z) {
  return spot(id, side * (COURT.cornerX + SHOOTER_LINE_CLEARANCE), z);
}

export const CONTEST_SPOTS = Object.freeze([
  behindCorner('left-corner', -1, 1.92),
  behindArc('left-wing', -4.77, 6.35),
  spot('left-logo', -3.28, 9.50, 'logo'),
  behindArc('top', 0, 8.33),
  spot('right-logo', 3.28, 9.50, 'logo'),
  behindArc('right-wing', 4.77, 6.35),
  behindCorner('right-corner', 1, 1.92),
]);

const SPOT_BY_ID = new Map(CONTEST_SPOTS.map((entry) => [entry.id, entry]));

function mesh(geometry, material) {
  const out = new THREE.Mesh(geometry, material);
  out.castShadow = true;
  out.receiveShadow = true;
  return out;
}

function fallbackRack() {
  const root = new THREE.Group();
  root.name = 'Rack';
  const metal = new THREE.MeshPhysicalMaterial({
    color: 0x151c23, roughness: 0.34, metalness: 0.82, clearcoat: 0.42,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x22cddd, emissive: 0x083840, emissiveIntensity: 0.8, roughness: 0.42, metalness: 0.4,
  });
  for (const x of [-0.68, 0.68]) {
    const leg = mesh(new THREE.BoxGeometry(0.065, 0.86, 0.065), metal);
    leg.position.set(x, 0.47, 0);
    root.add(leg);
    const foot = mesh(new THREE.BoxGeometry(0.16, 0.06, 0.40), metal);
    foot.position.set(x, 0.06, 0.04);
    root.add(foot);
  }
  const spine = mesh(new THREE.BoxGeometry(1.48, 0.075, 0.075), metal);
  spine.position.set(0, 0.74, 0.08);
  root.add(spine);
  const blade = mesh(new THREE.BoxGeometry(1.38, 0.20, 0.035), accent);
  blade.position.set(0, 0.51, 0.10);
  blade.rotation.x = -0.12;
  root.add(blade);
  for (let i = 0; i < 5; i++) {
    const cradle = mesh(new THREE.TorusGeometry(0.135, 0.014, 8, 24, Math.PI * 1.25), metal);
    cradle.rotation.set(Math.PI / 2, 0, -Math.PI * 0.125);
    cradle.position.set(-0.54 + i * 0.27, 0.86, 0);
    root.add(cradle);
  }
  return root;
}

function fallbackPedestal() {
  const root = new THREE.Group();
  root.name = 'Pedestal';
  const dark = new THREE.MeshPhysicalMaterial({
    color: 0x161b24, roughness: 0.32, metalness: 0.78, clearcoat: 0.5,
  });
  const teal = new THREE.MeshStandardMaterial({
    color: 0x2ce5ef, emissive: 0x0a4a52, emissiveIntensity: 1.0, roughness: 0.35,
  });
  const base = mesh(new THREE.CylinderGeometry(0.30, 0.38, 0.13, 8), dark);
  base.position.y = 0.065;
  root.add(base);
  const column = mesh(new THREE.CylinderGeometry(0.11, 0.17, 0.62, 8), dark);
  column.position.y = 0.42;
  root.add(column);
  const cap = mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.10, 12), teal);
  cap.position.y = 0.77;
  root.add(cap);
  return root;
}

function findNamed(root, pattern) {
  let found = null;
  root.traverse((object) => {
    if (!found && pattern.test(object.name ?? '')) found = object;
  });
  return found;
}

async function loadTemplates() {
  try {
    const gltf = await new GLTFLoader().loadAsync('/models/contest/vibe-contest-props.glb');
    const rack = findNamed(gltf.scene, /(^|_)rack($|_)/i);
    const pedestal = findNamed(gltf.scene, /pedestal|logo.*stand|range.*stand/i);
    if (!rack || !pedestal) throw new Error('GLB is missing named Rack/Pedestal roots');
    return { rack: rack.clone(true), pedestal: pedestal.clone(true), source: 'glb' };
  } catch (error) {
    console.warn('contest prop GLB unavailable; using procedural fallback:', error);
    return { rack: fallbackRack(), pedestal: fallbackPedestal(), source: 'procedural-fallback' };
  }
}

function cloneWithMaterials(object) {
  const clone = object.clone(true);
  clone.getObjectByName(`${clone.name}_LOD1`)?.traverse((child) => { child.visible = false; });
  clone.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    if (Array.isArray(child.material)) child.material = child.material.map((material) => material.clone());
    else if (child.material) child.material = child.material.clone();
  });
  return clone;
}

export class ContestRackSet {
  static async create(scene) {
    const templates = await loadTemplates();
    return new ContestRackSet(scene, templates);
  }

  constructor(scene, templates) {
    this.root = new THREE.Group();
    this.root.name = 'ThreePointContestProps';
    scene.add(this.root);
    this.source = templates.source;
    this.props = new Map();
    for (const station of STATIONS) {
      const spot = SPOT_BY_ID.get(station.id);
      const template = station.kind === 'logo' ? templates.pedestal : templates.rack;
      const prop = cloneWithMaterials(template);
      prop.name = `Contest_${station.id}`;
      prop.position.copy(spot.propPosition);
      prop.rotation.y = spot.propRotation;
      this.root.add(prop);
      this.props.set(station.id, prop);
    }

    this.ballGeometry = new THREE.SphereGeometry(0.119, 20, 14);
    this.ballMaterials = {
      standard: new THREE.MeshStandardMaterial({ color: 0xd46b27, roughness: 0.78, metalness: 0.0 }),
      money: new THREE.MeshStandardMaterial({ color: 0x52e6ef, emissive: 0x0c4850, emissiveIntensity: 0.8, roughness: 0.62 }),
      logo: new THREE.MeshStandardMaterial({ color: 0x4878ff, emissive: 0x10245f, emissiveIntensity: 0.85, roughness: 0.56 }),
    };
    this.ballMeshes = [];
    this.moneyRack = 'top';
    this.reset(this.moneyRack);
  }

  reset(moneyRack) {
    this.moneyRack = moneyRack;
    for (const ball of this.ballMeshes) this.root.remove(ball);
    this.ballMeshes.length = 0;
    const attempts = buildAttemptSequence(moneyRack);
    for (const attempt of attempts) {
      const spot = SPOT_BY_ID.get(attempt.stationId);
      const prop = this.props.get(attempt.stationId);
      const ball = mesh(this.ballGeometry, this.ballMaterials[attempt.kind]);
      const local = attempt.kind === 'logo'
        ? new THREE.Vector3(0, 0.93, 0)
        : new THREE.Vector3(-0.54 + attempt.ballIndex * 0.27, 0.91, 0);
      local.applyAxisAngle(Y_AXIS, prop.rotation.y).add(spot.propPosition);
      ball.position.copy(local);
      ball.name = `RackBall_${attempt.index}`;
      ball.userData.attemptIndex = attempt.index;
      this.root.add(ball);
      this.ballMeshes[attempt.index] = ball;
    }
  }

  consume(attemptIndex) {
    const ball = this.ballMeshes[attemptIndex];
    if (ball) ball.visible = false;
  }

  restore(attemptIndex) {
    const ball = this.ballMeshes[attemptIndex];
    if (ball) ball.visible = true;
  }

  setVisible(visible) {
    this.root.visible = visible;
  }
}

export function contestSpot(stationId) {
  return SPOT_BY_ID.get(stationId) ?? CONTEST_SPOTS[0];
}
