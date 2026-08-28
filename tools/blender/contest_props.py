"""
Build the three-point contest props — a five-ball rack and a logo-range
pedestal — as one portable GLB (`vibe-contest-props.glb`, the name
src/world/contestRacks.js loads).

    # author + export + manifest
    blender -b --python tools/blender/contest_props.py -- \
        --out public/models/contest/vibe-contest-props.glb

    # cold import the exported GLB in a fresh Blender and render the previews
    blender -b --python tools/blender/contest_props.py -- \
        --previews public/models/contest/vibe-contest-props.glb \
        --shots-dir public/models/contest/previews

Everything here is authored from primitives, so there is no third-party source
mesh, no texture, and nothing to license — the props are original geometry in a
made-up house style: dark cast metal, machined steel, and two accents (teal and
orange) picked out of the game's own UI palette.

Layout notes for the consuming scene, which is metres and Y-up with the hoop
toward -Z:

  * both roots sit at the world origin with their feet on y=0, so an instance is
    positioned by dropping it straight onto the court plane.
  * the emblem faces glTF -Z. The scene yaws each instance so local +Z points at
    the hoop, which leaves the emblem facing the shooter and the camera.
  * cradles take a 0.24 m ball and a seated ball's centre lands at 0.91 m on the
    rack (five slots on a 0.27 m pitch) and 0.93 m on the pedestal — the heights
    and pitch src/world/contestRacks.js already places its rack balls at.

The GLB carries both props and both LODs:

    Rack        -> Rack_LOD0, Rack_LOD1
    Pedestal    -> Pedestal_LOD0, Pedestal_LOD1

One file, one load, clone whichever root a station needs and hide the LOD you
are not showing. The LODs are separate builds rather than a decimation, because
these shapes are all revolved primitives — dropping segment counts and the
smallest trim keeps the silhouette exactly and costs nothing in seams.

The props are decorative. No collider is exported and none should be generated;
the ball never interacts with them.
"""
import bpy, bmesh, sys, os, math, json, hashlib, datetime
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
def flag(name):
    return name in argv

OUT        = arg('--out', 'public/models/contest/vibe-contest-props.glb')
PREVIEWS   = arg('--previews')
SHOTS_DIR  = arg('--shots-dir', 'public/models/contest/previews')
SHOT_W     = int(arg('--shot-width', 1280))
SHOT_H     = int(arg('--shot-height', 800))
# these land under public/ and ship with the build, so they are JPEG — the same
# frames as PNG are about a megabyte each and there are six of them
SHOT_EXT   = '.jpg'

# The consuming scene (src/world/contestRacks.js) draws its rack balls at
# radius 0.119 on a 0.27 m pitch, ball centres 0.91 m up on a rack and 0.93 m on
# a pedestal, and loads this file as vibe-contest-props.glb. Those numbers are
# the contract; the cradles are built to them rather than the other way round.
BALL_R     = 0.119                 # rack ball radius, m (0.238 m across)
RACK_PITCH = 0.27
RACK_BALL_Y = 0.91
PED_BALL_Y  = 0.93
FIT_R      = 0.125                 # gauge ball for the fit check — deliberately
                                   # larger than both this and the 0.121 m game
                                   # ball, so a pass covers either

TEAL       = (0.086, 0.639, 0.729)
ORANGE     = (0.949, 0.404, 0.106)


def log(*a):
    print('[contest]', *a)


# ---------------------------------------------------------------- materials

def srgb_to_linear(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, metallic, roughness, emit=None, emit_strength=0.0):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    lin = srgb_to_linear(color)
    bsdf.inputs['Base Color'].default_value = (*lin, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*srgb_to_linear(emit), 1.0)
        bsdf.inputs['Emission Strength'].default_value = emit_strength
    return mat


def materials():
    # A modest emission on the accents is deliberate. The court is a night
    # exterior under four spots with exponential fog; an unlit accent at the
    # arc reads as a grey smudge from the broadcast camera. Strength stays at
    # or below 1 so this is a plain core-glTF emissiveFactor, no extension.
    return {
        'cast':   material('VibeCastMetal', (0.106, 0.122, 0.149), 0.85, 0.44),
        'steel':  material('VibeSteel',     (0.310, 0.353, 0.400), 0.92, 0.28),
        'rubber': material('VibeGrip',      (0.051, 0.059, 0.075), 0.05, 0.94),
        'teal':   material('VibeAccentTeal',   TEAL,   0.35, 0.34, emit=TEAL,   emit_strength=0.30),
        'orange': material('VibeAccentOrange', ORANGE, 0.35, 0.34, emit=ORANGE, emit_strength=0.22),
    }


# ---------------------------------------------------------------- primitives

PARTS = []

def _finish(mat, name, smooth=True):
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    if smooth:
        try:
            bpy.ops.object.shade_auto_smooth(angle=math.radians(40))
        except Exception:
            bpy.ops.object.shade_smooth()
    PARTS.append(obj)
    return obj


def tube(mat, name, radius, length, loc, rot=(0, 0, 0), verts=12, caps=True):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=verts, radius=radius, depth=length, location=loc, rotation=rot,
        end_fill_type='NGON' if caps else 'NOTHING')
    return _finish(mat, name)


def taper(mat, name, r_bottom, r_top, length, loc, rot=(0, 0, 0), verts=12):
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts, radius1=r_bottom, radius2=r_top, depth=length,
        location=loc, rotation=rot)
    return _finish(mat, name)


def ring(mat, name, major, minor, loc, rot=(0, 0, 0), major_seg=24, minor_seg=8):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=major_seg,
        minor_segments=minor_seg, location=loc, rotation=rot)
    return _finish(mat, name)


def slab(mat, name, size, loc, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(mat, name, smooth=False)


def strut(mat, name, radius, a, b, verts=8):
    """A tube from point a to point b, which is most of what a frame is."""
    a, b = Vector(a), Vector(b)
    d = b - a
    rot = d.to_track_quat('Z', 'Y').to_euler()
    return tube(mat, name, radius, d.length, tuple((a + b) / 2), tuple(rot), verts=verts)


# ---------------------------------------------------------------- the props
#
# Blender is Z-up here; the exporter converts to the scene's Y-up. The emblem
# face is Blender +Y, which lands on -Z in the GLB. That is the far side from
# the default camera in isolation, but the consuming scene yaws every instance
# with rotation.y = atan2(rimX - x, rimZ - z), which points local +Z at the
# hoop — so local -Z ends up facing the shooter and the broadcast camera.
FRONT = 1.0

CRADLE_MAJOR = 0.095     # ball seats on this ring...
CRADLE_MINOR = 0.018
# ...so a BALL_R ball's centre floats sqrt(r^2 - major^2) above the ring plane.
CRADLE_LIFT  = math.sqrt(BALL_R ** 2 - CRADLE_MAJOR ** 2)


def cradle(mats, tag, x, y, ring_z, lod):
    """Ring the ball beds into, over a flared cup that gives it visual weight."""
    seg = 24 if lod == 0 else 10
    verts = 16 if lod == 0 else 8
    ring(mats['steel'], f'{tag}_ring', CRADLE_MAJOR, CRADLE_MINOR, (x, y, ring_z),
         major_seg=seg, minor_seg=8 if lod == 0 else 5)
    taper(mats['cast'], f'{tag}_cup', 0.058, 0.104, 0.085,
          (x, y, ring_z - 0.048), verts=verts)
    if lod == 0:
        # a thin collar under the cup, purely so the cup does not read as a
        # floating cone in a three-quarter silhouette
        ring(mats['cast'], f'{tag}_collar', 0.062, 0.010, (x, y, ring_z - 0.092),
             major_seg=16, minor_seg=6)


def chevron(mats, tag, cx, cz, y, width, lod, mat_key='teal'):
    """The house mark: a wide V with a detached leading bar above it.

    Drawn as geometry rather than a decal so it survives at broadcast distance
    and keeps the package texture-free.
    """
    bar_h = width * 0.16
    arm = width * 0.52
    for sign in (-1, 1):
        slab(mats[mat_key], f'{tag}_chev_{"l" if sign < 0 else "r"}',
             (arm, 0.016, bar_h),
             (cx + sign * width * 0.24, y, cz - width * 0.10),
             rot=(0, sign * math.radians(32), 0))
    if lod == 0:
        slab(mats[mat_key], f'{tag}_chev_bar', (width * 0.62, 0.016, bar_h * 0.72),
             (cx, y, cz + width * 0.20))


def build_rack(mats, lod):
    """Five cradles on a braced rail, on A-frames over rubber skids."""
    PARTS.clear()
    verts = 16 if lod == 0 else 8
    slots = [(i - 2) * RACK_PITCH for i in range(5)]
    ring_z = RACK_BALL_Y - CRADLE_LIFT           # ball centres land at 0.91 m
    rail_z, rail_y = 0.700, 0.108
    skid_y, skid_z = 0.262, 0.036

    for i, x in enumerate(slots):
        cradle(mats, f'Rack_slot{i}', x, 0.0, ring_z, lod)
        # a short post dropping each cradle onto the rails
        tube(mats['cast'], f'Rack_post{i}', 0.026, ring_z - 0.092 - rail_z + 0.04,
             (x, 0.0, (ring_z - 0.092 + rail_z) / 2), verts=verts)

    for sign in (-1, 1):
        side = 'f' if sign > 0 else 'b'
        tube(mats['steel'], f'Rack_rail_{side}', 0.021, 1.30,
             (0.0, sign * rail_y, rail_z), rot=(0, math.radians(90), 0), verts=verts)
        tube(mats['rubber'], f'Rack_skid_{side}', 0.034, 1.36,
             (0.0, sign * skid_y, skid_z), rot=(0, math.radians(90), 0), verts=verts)

    # A-frames: the outboard pair carries the load, the inboard pair kills the
    # sag. They straddle the centre rather than sitting on it — a leg at x=0
    # cuts the emblem in half from straight on, which is the angle it is read at.
    for x in (-0.60, -0.28, 0.28, 0.60):
        for sign in (-1, 1):
            strut(mats['cast'], f'Rack_leg_{x}_{sign}', 0.024 if abs(x) > 0.5 else 0.019,
                  (x, sign * rail_y, rail_z), (x, sign * skid_y, skid_z), verts=verts)
        if lod == 0 and abs(x) > 0.5:
            strut(mats['steel'], f'Rack_tie_{x}', 0.013,
                  (x, -skid_y, skid_z + 0.02), (x, skid_y, skid_z + 0.02), verts=6)

    # front apron — the one broad value in the silhouette, and what separates
    # this from a bare pipe frame. It hangs off the front rail and sits flush
    # with the legs at that height; pushed any further forward it stops reading
    # as part of the rack and starts reading as a barricade board.
    slab(mats['cast'], 'Rack_apron', (1.20, 0.022, 0.215), (0.0, FRONT * 0.130, 0.552))
    slab(mats['orange'], 'Rack_apron_band', (1.20, 0.014, 0.030), (0.0, FRONT * 0.144, 0.468))
    if lod == 0:
        slab(mats['teal'], 'Rack_apron_edge', (1.20, 0.014, 0.014), (0.0, FRONT * 0.144, 0.648))
    # sized and centred to clear both apron stripes
    chevron(mats, 'Rack', 0.0, 0.562, FRONT * 0.146, 0.22, lod, mat_key='teal')

    return list(PARTS)


def build_pedestal(mats, lod):
    """One cradle on a fluted column — the marker for a deep logo-range station."""
    PARTS.clear()
    verts = 24 if lod == 0 else 10
    seg = 24 if lod == 0 else 10
    ring_z = PED_BALL_Y - CRADLE_LIFT            # ball centre at 0.93 m

    taper(mats['cast'], 'Ped_base', 0.300, 0.272, 0.052, (0, 0, 0.026), verts=verts)
    ring(mats['teal'], 'Ped_base_ring', 0.292, 0.013, (0, 0, 0.050),
         major_seg=seg, minor_seg=8 if lod == 0 else 5)
    taper(mats['cast'], 'Ped_column', 0.156, 0.106, 0.670, (0, 0, 0.385), verts=verts)

    if lod == 0:
        # six flutes: the column is a plain revolve otherwise, and a rim light
        # needs something to break on
        for i in range(6):
            a = math.tau * i / 6 + math.radians(30)
            strut(mats['steel'], f'Ped_flute{i}', 0.011,
                  (math.cos(a) * 0.152, math.sin(a) * 0.152, 0.090),
                  (math.cos(a) * 0.108, math.sin(a) * 0.108, 0.680), verts=6)

    tube(mats['cast'], 'Ped_collar', 0.134, 0.052, (0, 0, 0.746), verts=verts)
    ring(mats['orange'], 'Ped_collar_ring', 0.136, 0.013, (0, 0, 0.746),
         major_seg=seg, minor_seg=8 if lod == 0 else 5)
    tube(mats['steel'], 'Ped_neck', 0.072, 0.100, (0, 0, 0.800), verts=verts)
    cradle(mats, 'Ped', 0.0, 0.0, ring_z, lod)

    # emblem plate, standing proud of the taper so it stays readable head-on
    slab(mats['cast'], 'Ped_plate', (0.230, 0.020, 0.190), (0.0, FRONT * 0.146, 0.440))
    slab(mats['teal'], 'Ped_plate_band', (0.230, 0.014, 0.024), (0.0, FRONT * 0.158, 0.356))
    chevron(mats, 'Ped', 0.0, 0.464, FRONT * 0.160, 0.20, lod, mat_key='orange')

    return list(PARTS)


# ---------------------------------------------------------------- assembly

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    merged = bpy.context.object
    merged.name = name
    merged.data.name = name

    # welding the coincident primitive walls together keeps the vertex count
    # honest and stops the exporter shipping interior shells
    mesh = bmesh.new()
    mesh.from_mesh(merged.data)
    bmesh.ops.remove_doubles(mesh, verts=mesh.verts, dist=0.0004)
    mesh.to_mesh(merged.data)
    mesh.free()
    merged.data.update()
    return merged


def tri_count(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = materials()
    stats = {}
    for prop_name, builder in (('Rack', build_rack), ('Pedestal', build_pedestal)):
        bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
        root = bpy.context.object
        root.name = prop_name
        root.empty_display_size = 0.25
        for lod in (0, 1):
            merged = join(builder(mats, lod), f'{prop_name}_LOD{lod}')
            merged.parent = root
            merged.matrix_parent_inverse = root.matrix_world.inverted()
            stats[merged.name] = tri_count(merged)
            log(f'{merged.name}: {stats[merged.name]} tris, '
                f'{len(merged.data.materials)} materials')
    return stats


def bounds(obj):
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(p[i] for p in pts) for i in range(3)))
    hi = Vector((max(p[i] for p in pts) for i in range(3)))
    return lo, hi


def export(path, stats):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=False,
        export_apply=True, export_yup=True, export_animations=False,
        # no textures anywhere in this package, so UVs are dead weight — about
        # a third of the buffer went to them before this
        export_texcoords=False, export_tangents=False,
        export_skins=False, export_morph=False, export_cameras=False,
        export_lights=False, export_extras=False,
        export_texture_dir='', export_image_format='NONE')
    log('wrote', path, os.path.getsize(path), 'bytes')
    return stats


# ---------------------------------------------------------------- manifest

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def write_manifest(glb, stats):
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, 'contest_props.py')
    lods = {}
    for name in ('Rack_LOD0', 'Rack_LOD1', 'Pedestal_LOD0', 'Pedestal_LOD1'):
        obj = bpy.data.objects.get(name)
        lo, hi = bounds(obj)
        # report in the consuming scene's Y-up axes: glTF (x, z, -y) of Blender
        lods[name] = {
            'triangles': stats[name],
            'materials': [m.name for m in obj.data.materials],
            'bounds_m_yup': {
                'min': [round(lo.x, 4), round(lo.z, 4), round(-hi.y, 4)],
                'max': [round(hi.x, 4), round(hi.z, 4), round(-lo.y, 4)],
            },
        }
    manifest = {
        'asset': 'vibe-contest-props',
        'version': 1,
        'workstream': 'three-point-contest-props',
        'provider': 'claude-code',
        'model': 'claude-opus-5',
        'effort': 'medium',
        'timestamp_utc': datetime.datetime.now(datetime.timezone.utc)
                                  .replace(microsecond=0).isoformat(),
        'tools': {
            'blender': bpy.app.version_string,
            'gltf_exporter': '.'.join(
                str(v) for v in getattr(
                    __import__('io_scene_gltf2'), 'bl_info', {'version': (0, 0, 0)}
                ).get('version', (0, 0, 0))
            ) if 'io_scene_gltf2' in sys.modules else 'bundled',
            'python': sys.version.split()[0],
            'platform': sys.platform,
        },
        'source': {
            'path': 'tools/blender/contest_props.py',
            'sha256': sha256(src),
        },
        'glb': {
            'path': os.path.relpath(glb, os.path.dirname(here) + '/..'),
            'bytes': os.path.getsize(glb),
            'sha256': sha256(glb),
        },
        'scene_contract': {
            'units': 'metres',
            'up': 'Y',
            'front': '-Z (emblem side; the scene yaws local +Z at the hoop, '
                     'which leaves the emblem facing the shooter and camera)',
            'origin': 'feet on y=0, centred on x/z',
            'ball_diameter_m': round(BALL_R * 2, 3),
            'cradle_ring_radius_m': CRADLE_MAJOR,
            'rack_slot_pitch_m': RACK_PITCH,
            'rack_slot_x_m': [round((i - 2) * RACK_PITCH, 3) for i in range(5)],
            'rack_ball_centre_y_m': RACK_BALL_Y,
            'pedestal_ball_centre_y_m': PED_BALL_Y,
            'consumer': 'src/world/contestRacks.js',
            'collision': 'none — decorative only, no collider is exported',
        },
        'roots': {
            'Rack': ['Rack_LOD0', 'Rack_LOD1'],
            'Pedestal': ['Pedestal_LOD0', 'Pedestal_LOD1'],
        },
        'lods': lods,
        'licensing': {
            'origin': 'original geometry authored procedurally in this script',
            'third_party_source': 'none',
            'textures': 'none — untextured PBR materials only',
            'marks': 'no NBA, State Farm, Starry, Wilson or any third-party mark',
        },
    }
    out = os.path.join(os.path.dirname(glb), 'manifest.json')
    with open(out, 'w') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    log('wrote', out)
    return out


# ---------------------------------------------------------------- previews

def setup_render():
    sc = bpy.context.scene
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
        try:
            sc.render.engine = engine
            break
        except TypeError:
            continue
    if sc.render.engine == 'CYCLES':
        sc.cycles.samples = 48
    sc.render.resolution_x, sc.render.resolution_y = SHOT_W, SHOT_H
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = 90
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'Standard'

    if sc.world is None:
        sc.world = bpy.data.worlds.new('preview')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value = (0.055, 0.062, 0.075, 1)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = 1.0

    def lamp(name, energy, loc, size, color=(1, 1, 1)):
        light = bpy.data.lights.new(name, 'AREA')
        light.energy, light.size, light.color = energy, size, color
        obj = bpy.data.objects.new(name, light)
        obj.location = loc
        obj.rotation_euler = (Vector((0, 0, 0.85)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.collection.objects.link(obj)

    lamp('key',  900, (-2.4, -3.0, 3.4), 3.0, (1.0, 0.95, 0.88))
    lamp('fill', 220, (3.2, -2.2, 1.8), 3.0, (0.78, 0.86, 1.0))
    lamp('rim',  420, (1.4, 3.0, 2.6), 2.4, (0.85, 0.92, 1.0))

    floor = bpy.data.meshes.new('floor')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=14)
    bm.to_mesh(floor)
    bm.free()
    obj = bpy.data.objects.new('floor', floor)
    mat = material('PreviewFloor', (0.117, 0.128, 0.147), 0.0, 0.72)
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    return obj


def frame(targets, direction, up_bias=0.0, fill=0.82, lens=52.0, ortho_top=False):
    """Place a camera looking at the targets' shared bounding box."""
    pts = []
    for o in targets:
        pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = Vector((min(p[i] for p in pts) for i in range(3)))
    hi = Vector((max(p[i] for p in pts) for i in range(3)))
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.2)

    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    if ortho_top:
        cam_data.type = 'ORTHO'
        cam_data.ortho_scale = max(hi.x - lo.x, hi.y - lo.y) * 1.25
        cam.location = centre + Vector((0, 0, radius * 4 + 2))
        cam.rotation_euler = (0, 0, 0)
    else:
        cam_data.lens = lens
        sensor = cam_data.sensor_width
        dist = (radius / fill) * (lens / sensor) * 2.0
        d = Vector(direction).normalized()
        cam.location = centre + d * dist + Vector((0, 0, up_bias))
        cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    return cam


def clear_cams():
    for o in [o for o in bpy.data.objects if o.type == 'CAMERA']:
        bpy.data.objects.remove(o, do_unlink=True)


def shoot(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log('shot', path, os.path.getsize(path), 'bytes')


def gauge_balls(mat):
    """Gauge spheres dropped into the rack, to show the fit is real."""
    made = []
    for i in range(5):
        x = (i - 2) * RACK_PITCH
        bpy.ops.mesh.primitive_uv_sphere_add(
            radius=FIT_R, segments=24, ring_count=14, location=(x, 0.0, RACK_BALL_Y))
        obj = bpy.context.object
        obj.name = f'gauge{i}'
        obj.data.materials.append(mat)
        bpy.ops.object.shade_smooth()
        made.append(obj)
    return made


def previews(glb, outdir):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    log('cold import', glb)
    bpy.ops.import_scene.gltf(filepath=glb)
    imported = sorted(o.name for o in bpy.data.objects)
    log('imported objects:', imported)
    for name in ('Rack', 'Pedestal', 'Rack_LOD0', 'Rack_LOD1',
                 'Pedestal_LOD0', 'Pedestal_LOD1'):
        if name not in bpy.data.objects:
            raise SystemExit(f'cold import is missing {name}')

    os.makedirs(outdir, exist_ok=True)
    setup_render()

    rack0 = bpy.data.objects['Rack_LOD0']
    rack1 = bpy.data.objects['Rack_LOD1']
    ped0 = bpy.data.objects['Pedestal_LOD0']
    ped1 = bpy.data.objects['Pedestal_LOD1']

    def show(*visible):
        for o in (rack0, rack1, ped0, ped1):
            o.hide_render = o not in visible

    # both props side by side, LOD0 only
    bpy.data.objects['Pedestal'].location = (1.55, 0, 0)
    show(rack0, ped0)
    pair = [rack0, ped0]

    clear_cams(); frame(pair, (0, 1, 0.16), up_bias=0.15)
    shoot(os.path.join(outdir, 'front' + SHOT_EXT))

    clear_cams(); frame(pair, (0.85, 1, 0.42), up_bias=0.10)
    shoot(os.path.join(outdir, 'three-quarter' + SHOT_EXT))

    clear_cams(); frame(pair, (0, 0, 1), ortho_top=True)
    shoot(os.path.join(outdir, 'top' + SHOT_EXT))

    # LOD0 against LOD1 in the same frame, same angle. The offset goes on the
    # LOD meshes, not the roots — the roots carry both LODs, so moving those
    # just slides the pair and leaves LOD1 parked on top of LOD0. It also has
    # to be a delta: the importer parks the Y-up conversion in each child's own
    # location, so assigning a fresh vector drops the prop through the floor.
    for o in (rack1, ped1):
        o.location.x += 3.10
    show(rack0, ped0, rack1, ped1)
    bpy.context.view_layer.update()
    clear_cams(); frame([rack0, ped0, rack1, ped1], (0.35, 1, 0.42), fill=0.92)
    shoot(os.path.join(outdir, 'lod0-vs-lod1' + SHOT_EXT))

    for o in (rack1, ped1):
        o.location.x -= 3.10
    bpy.context.view_layer.update()
    show(rack0, ped0)

    # fit check: gauge balls seated in every cradle
    gauge = material('GaugeBall', (0.776, 0.353, 0.129), 0.0, 0.62)
    balls = gauge_balls(gauge)
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=FIT_R, segments=24, ring_count=14, location=(1.55, 0.0, PED_BALL_Y))
    bpy.context.object.name = 'gauge_ped'
    bpy.context.object.data.materials.append(gauge)
    bpy.ops.object.shade_smooth()
    balls.append(bpy.context.object)
    clear_cams(); frame(pair + balls, (0.55, 1, 0.30), up_bias=0.10)
    shoot(os.path.join(outdir, 'fit-check' + SHOT_EXT))

    # broadcast: 14 m out at camera height, the distance these are actually read at
    clear_cams()
    cam_data = bpy.data.cameras.new('bcam')
    cam = bpy.data.objects.new('bcam', cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    cam_data.lens = 50.0
    cam.location = (0.8, 13.6, 2.9)
    cam.rotation_euler = (Vector((0.78, 0, 0.62)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    shoot(os.path.join(outdir, 'broadcast-14m' + SHOT_EXT))

    for o in balls:
        bpy.data.objects.remove(o, do_unlink=True)

    stamp = {
        'cold_import': {
            'file': os.path.basename(glb),
            'blender': bpy.app.version_string,
            'objects': imported,
            'roots_found': ['Rack', 'Pedestal'],
            'errors': 'none',
        },
        'previews': [
            {'file': f, 'sha256': sha256(os.path.join(outdir, f)),
             'bytes': os.path.getsize(os.path.join(outdir, f))}
            for f in sorted(os.listdir(outdir)) if f.endswith(SHOT_EXT)
        ],
    }
    man_path = os.path.join(os.path.dirname(glb), 'manifest.json')
    if os.path.exists(man_path):
        with open(man_path) as fh:
            manifest = json.load(fh)
        manifest['evidence'] = stamp
        with open(man_path, 'w') as fh:
            json.dump(manifest, fh, indent=2)
            fh.write('\n')
        log('updated', man_path)


# ---------------------------------------------------------------- entry

if PREVIEWS:
    previews(os.path.abspath(PREVIEWS), os.path.abspath(SHOTS_DIR))
else:
    stats = build()
    out = os.path.abspath(OUT)
    export(out, stats)
    write_manifest(out, stats)
