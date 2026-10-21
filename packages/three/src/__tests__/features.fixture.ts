import type { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import type * as ThreeCore from 'three/src/Three.Core.js';

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fixture data');
  return value;
}

export function featureCases(THREE: typeof ThreeCore & { ClippingGroup: typeof ClippingGroup }) {
  return {
    'groups-colors': (scene) => {
      const geometry = new THREE.BoxGeometry(1.8, 1.6, 1);
      geometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          Array.from({ length: geometry.getAttribute('position').count * 3 }, (_, i) =>
            i % 3 === 1 ? 0.2 : 0.8,
          ),
          3,
        ),
      );
      const colored = new THREE.MeshBasicMaterial({ vertexColors: true });
      const plain = new THREE.MeshBasicMaterial({ color: 0x70bdee });
      const mesh = new THREE.Mesh(geometry, [colored, plain, colored, plain, colored, plain]);
      mesh.rotation.set(0.3, 0.5, 0);
      scene.add(mesh);
      return () => {
        colored.visible = false;
        plain.color.set(0xeec050);
      };
    },
    'scene-callback': (scene) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 1.5, 1),
        new THREE.MeshBasicMaterial({ color: 0x70bd90 }),
      );
      scene.add(mesh);
      let color = 0x70bd90;
      scene.onBeforeRender = (_renderer, actualScene) => {
        if (actualScene.type !== 'Scene') throw new Error('Unexpected callback scene');
        mesh.material.color.set(color);
      };
      return () => {
        color = 0xc07850;
      };
    },
    sprite: (scene) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ color: 0x70bbe0, rotation: 0.35 }),
      );
      sprite.scale.set(1.6, 1.2, 1);
      scene.add(sprite);
      return () => {
        sprite.center.set(0.1, 0.7);
        sprite.material.rotation = -0.4;
        sprite.material.sizeAttenuation = false;
        sprite.scale.multiplyScalar(0.2);
      };
    },
    'lines-dashes': (scene) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1.3, -0.7, 0),
        new THREE.Vector3(-0.3, 0.8, 0),
        new THREE.Vector3(1.3, -0.7, 0),
      ]);
      const line = new THREE.Line(
        geometry,
        new THREE.LineDashedMaterial({ color: 0xff8050, dashSize: 0.18, gapSize: 0.12 }),
      );
      line.computeLineDistances();
      scene.add(line);
      return () => {
        line.material.scale = 2;
        line.rotation.z = 0.3;
      };
    },
    points: (scene) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        Array.from(
          { length: 25 },
          (_, i) => new THREE.Vector3(((i % 5) - 2) * 0.4, (Math.floor(i / 5) - 2) * 0.4, 0),
        ),
      );
      const points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ color: 0xe0a050, size: 20 }),
      );
      scene.add(points);
      return () => {
        points.material.size = 2;
        points.material.sizeAttenuation = false;
        points.rotation.z = 0.2;
      };
    },
    instances: (scene) => {
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.6, 0.6, 0.6),
        new THREE.MeshBasicMaterial({ color: 0x50bcdd }),
        3,
      );
      for (let i = 0; i < 3; i++)
        mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i - 1, (i % 2) * 0.6, 0));
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      return () => {
        mesh.count = 2;
        mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-0.8, -0.7, 0));
        mesh.instanceMatrix.needsUpdate = true;
      };
    },
    morph: (scene) => {
      const geometry = new THREE.BoxGeometry(1.4, 1.4, 0.8);
      const base = geometry.getAttribute('position');
      const target = base.clone();
      for (let i = 0; i < base.count; i++)
        target.setXYZ(i, base.getX(i) + 0.4 * base.getY(i), base.getY(i) * 0.5, base.getZ(i));
      geometry.morphAttributes.position = [target];
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xd5a840 }));
      scene.add(mesh);
      return () => {
        if (mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[0] = 0.8;
      };
    },
    'instance-colors-morph': (scene) => {
      const geometry = new THREE.BoxGeometry(0.65, 0.65, 0.65),
        base = geometry.getAttribute('position');
      const target = base.clone();
      for (let i = 0; i < base.count; i++) target.setY(i, base.getY(i) * 2);
      geometry.morphAttributes.position = [target];
      const material = new THREE.MeshBasicMaterial();
      geometry.morphTargetsRelative = true;
      const mesh = new THREE.InstancedMesh(geometry, material, 3),
        pose = new THREE.Mesh(geometry, material);
      for (let i = 0; i < 3; i++) {
        mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i - 1, 0, 0));
        mesh.setColorAt(i, new THREE.Color([0xe07050, 0x50c090, 0x7090e0][i]));
        required(pose.morphTargetInfluences)[0] = i * 0.4;
        mesh.setMorphAt(i, pose);
      }
      mesh.instanceMatrix.needsUpdate = true;
      required(mesh.instanceColor).needsUpdate = true;
      required(mesh.morphTexture).needsUpdate = true;
      scene.add(mesh);
      return () => {
        mesh.count = 2;
        mesh.setColorAt(0, new THREE.Color(0x7090e0));
        required(mesh.instanceColor).needsUpdate = true;
        required(pose.morphTargetInfluences)[0] = 1;
        mesh.setMorphAt(0, pose);
        required(mesh.morphTexture).needsUpdate = true;
      };
    },
    batch: (scene) => {
      const mesh = new THREE.BatchedMesh(5, 128, 512, new THREE.MeshBasicMaterial());
      const a = mesh.addGeometry(new THREE.BoxGeometry(0.7, 0.7, 0.7)),
        b = mesh.addGeometry(new THREE.PlaneGeometry(0.8, 1.2));
      const first = mesh.addInstance(a),
        hole = mesh.addInstance(a),
        last = mesh.addInstance(b);
      mesh.deleteInstance(hole);
      mesh.setMatrixAt(first, new THREE.Matrix4().makeTranslation(-0.7, 0, 0));
      mesh.setMatrixAt(last, new THREE.Matrix4().makeTranslation(0.7, 0, 0));
      mesh.setColorAt(first, new THREE.Color(0x50bbaa));
      mesh.setColorAt(last, new THREE.Color(0xd0a050));
      scene.add(mesh);
      return () => {
        mesh.setVisibleAt(first, false);
        const inserted = mesh.addInstance(a);
        mesh.setMatrixAt(inserted, new THREE.Matrix4().makeTranslation(-0.7, 0.5, 0));
        mesh.setColorAt(inserted, new THREE.Color(0xe06080));
      };
    },
    skin: (scene) => {
      const geometry = new THREE.BoxGeometry(1.1, 1.5, 0.6);
      const position = geometry.getAttribute('position');
      geometry.setAttribute(
        'skinIndex',
        new THREE.Uint16BufferAttribute(
          Array.from({ length: position.count * 4 }, (_, i) =>
            i % 4 === 0 && position.getY(Math.floor(i / 4)) > 0 ? 1 : 0,
          ),
          4,
        ),
      );
      geometry.setAttribute(
        'skinWeight',
        new THREE.Float32BufferAttribute(
          Array.from({ length: position.count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
          4,
        ),
      );
      const mesh = new THREE.SkinnedMesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: 0xc0a060 }),
      );
      const root = new THREE.Bone(),
        tip = new THREE.Bone();
      root.add(tip);
      mesh.add(root);
      mesh.bind(new THREE.Skeleton([root, tip]));
      scene.add(mesh);
      return () => {
        tip.rotation.z = 0.55;
        mesh.position.x = 0.3;
      };
    },
    clipping: (scene) => {
      const group = new THREE.ClippingGroup();
      group.clippingPlanes.push(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0));
      group.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshBasicMaterial({ color: 0x60d0bb }),
        ),
      );
      scene.add(group);
      return () => {
        group.clipIntersection = true;
        group.clippingPlanes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
      };
    },
    stencil: (scene) => {
      const mask = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 1.6),
        new THREE.MeshBasicMaterial({
          colorWrite: false,
          depthWrite: false,
          stencilWrite: true,
          stencilRef: 2,
          stencilZPass: THREE.ReplaceStencilOp,
        }),
      );
      mask.position.z = 0.5;
      const visible = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 1.2),
        new THREE.MeshBasicMaterial({
          color: 0x80bddf,
          stencilWrite: true,
          stencilRef: 2,
          stencilFunc: THREE.EqualStencilFunc,
        }),
      );
      scene.add(mask, visible);
      return () => {
        mask.position.x = 0.4;
        visible.material.stencilFunc = THREE.NotEqualStencilFunc;
      };
    },
    rect: (scene) => {
      scene.add(
        new THREE.Mesh(
          new THREE.PlaneGeometry(2.8, 2.8),
          new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.55 }),
        ),
      );
      const light = new THREE.RectAreaLight(0xffeebb, 5, 1.5, 1);
      light.position.set(0, 0, 2);
      scene.add(light);
      return () => {
        light.position.x = 0.7;
        light.lookAt(0, 0, 0);
        light.width = 0.8;
      };
    },
    environment: (scene) => {
      const texture = new THREE.DataTexture(
        Uint8Array.from({ length: 64 * 32 * 4 }, (_, i) => [100, 145, 205, 255][i % 4] ?? 0),
        64,
        32,
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.needsUpdate = true;
      scene.environment = texture;
      scene.background = texture;
      scene.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(0.9, 32, 20),
          new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }),
        ),
      );
      return () => {
        scene.environmentIntensity = 0.5;
        scene.backgroundIntensity = 0.5;
        scene.environmentRotation.y = 0.7;
        scene.backgroundRotation.y = -0.4;
      };
    },
    wireframe: (scene) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.6, 1.6),
        new THREE.MeshBasicMaterial({ wireframe: true, color: 0xffaa55 }),
      );
      mesh.rotation.set(0.3, 0.5, 0);
      scene.add(mesh);
      return () => {
        mesh.rotation.z = 0.35;
        mesh.material.color.set(0x5599dd);
      };
    },
    'matcap-default': (scene) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 20),
        new THREE.MeshMatcapMaterial(),
      );
      scene.add(mesh);
      return () => {
        mesh.material.color.set(0xd07080);
        mesh.position.x = 0.5;
      };
    },
    'uv-affine': (scene) => {
      const data = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) =>
        i % 4 === 3
          ? 255
          : Math.floor(i / 4) % 8 < 4
            ? ([220, 90, 40][i % 4] ?? 0)
            : ([40, 140, 200][i % 4] ?? 0),
      );
      const texture = new THREE.DataTexture(data, 8, 8);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(2, 3);
      texture.rotation = 0.45;
      texture.needsUpdate = true;
      scene.add(
        new THREE.Mesh(
          new THREE.PlaneGeometry(2.4, 2.4),
          new THREE.MeshBasicMaterial({ map: texture }),
        ),
      );
      return () => {
        texture.matrixAutoUpdate = false;
        texture.matrix.set(1, 0.4, 0.2, 0.3, 2, 0, 0, 0, 1);
      };
    },
    'clipping-mixed': (scene) => {
      const outer = new THREE.ClippingGroup();
      outer.clippingPlanes.push(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.5));
      const inner = new THREE.ClippingGroup();
      inner.clipIntersection = true;
      inner.clippingPlanes.push(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      );
      inner.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshBasicMaterial({ color: 0x80b050, side: THREE.DoubleSide }),
        ),
      );
      outer.add(inner);
      scene.add(outer);
      return () => {
        required(outer.clippingPlanes[0]).constant = -0.2;
        required(inner.clippingPlanes[0]).constant = 0.3;
      };
    },
    'flat-matcap': (scene) => {
      const geometry = new THREE.SphereGeometry(1, 9, 6);
      geometry.deleteAttribute('normal');
      const target = geometry.getAttribute('position').clone();
      for (let i = 0; i < target.count; i++) target.setX(i, target.getX(i) + target.getY(i) * 0.5);
      geometry.morphAttributes.position = [target];
      const mesh = new THREE.Mesh(geometry, new THREE.MeshMatcapMaterial({ color: 0x70b090 }));
      scene.add(mesh);
      return () => {
        required(mesh.morphTargetInfluences)[0] = 0.8;
      };
    },
    'uv-missing': (scene) => {
      const texture = new THREE.DataTexture(
        new Uint8Array([30, 140, 180, 255, 180, 50, 20, 255, 30, 70, 150, 255, 170, 130, 60, 255]),
        2,
        2,
      );
      texture.channel = 2;
      texture.needsUpdate = true;
      scene.add(
        new THREE.Mesh(
          new THREE.PlaneGeometry(2, 2),
          new THREE.MeshBasicMaterial({ map: texture }),
        ),
      );
      return () => {
        texture.offset.set(0.8, 0.5);
      };
    },
    'physical-clearcoat-map': (scene) => {
      const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      map.needsUpdate = true;
      const material = new THREE.MeshPhysicalMaterial({
        clearcoat: 0.8,
        clearcoatRoughness: 0.3,
        clearcoatMap: map,
        color: 0x60b080,
        roughness: 0.7,
      });
      scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material));
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(2, 3, 5);
      scene.add(sun);
      return () => {
        material.clearcoat = 0.2;
      };
    },
    'physical-map-combination': (scene) => {
      const image = new THREE.DataTexture(
        new Uint8Array([40, 150, 80, 255, 210, 70, 40, 255, 40, 80, 170, 255, 180, 150, 40, 255]),
        2,
        2,
      );
      image.needsUpdate = true;
      const normal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
      normal.needsUpdate = true;
      const scalar = new THREE.DataTexture(new Uint8Array([180, 170, 100, 255]), 1, 1);
      scalar.needsUpdate = true;
      const material = new THREE.MeshPhysicalMaterial({
        map: image,
        normalMap: normal,
        roughnessMap: scalar,
        metalnessMap: scalar,
        clearcoatMap: scalar,
        roughness: 0.7,
        metalness: 0.2,
        clearcoat: 0.7,
        clearcoatRoughness: 0.4,
      });
      scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material));
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(2, 3, 5);
      scene.add(sun);
      return () => {
        required(image.image.data)[0] = 190;
        image.needsUpdate = true;
        material.clearcoat = 0.3;
      };
    },
    'normal-bump-priority': (scene) => {
      const normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
      normalMap.needsUpdate = true;
      const bumpMap = new THREE.DataTexture(
        new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]),
        2,
        2,
      );
      bumpMap.needsUpdate = true;
      const material = new THREE.MeshStandardMaterial({ color: 0x70b090, normalMap, bumpMap });
      scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material));
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(2, 3, 5);
      scene.add(sun);
      return () => {
        material.bumpScale = 8;
      };
    },
    'morph-color': (scene) => {
      const geometry = new THREE.BoxGeometry(1.4, 1.4, 0.8),
        count = geometry.getAttribute('position').count;
      geometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          Array.from({ length: count * 3 }, (_, i) => [0.8, 0.2, 0.1][i % 3] ?? 0),
          3,
        ),
      );
      geometry.morphAttributes.position = [geometry.getAttribute('position').clone()];
      geometry.morphAttributes.color = [
        new THREE.Float32BufferAttribute(
          Array.from({ length: count * 3 }, (_, i) => [0.1, 0.4, 0.8][i % 3] ?? 0),
          3,
        ),
      ];
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
      scene.add(mesh);
      return () => {
        required(mesh.morphTargetInfluences)[0] = 0.8;
      };
    },
    'skin-lit': (scene) => {
      const geometry = new THREE.BoxGeometry(1.1, 1.5, 0.6),
        position = geometry.getAttribute('position');
      geometry.setAttribute(
        'skinIndex',
        new THREE.Uint16BufferAttribute(
          Array.from({ length: position.count * 4 }, (_, i) =>
            i % 4 === 0 && position.getY(Math.floor(i / 4)) > 0 ? 1 : 0,
          ),
          4,
        ),
      );
      geometry.setAttribute(
        'skinWeight',
        new THREE.Float32BufferAttribute(
          Array.from({ length: position.count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
          4,
        ),
      );
      const mesh = new THREE.SkinnedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0xc0a060, roughness: 0.7 }),
      );
      const root = new THREE.Bone(),
        tip = new THREE.Bone();
      root.add(tip);
      mesh.add(root);
      mesh.bind(new THREE.Skeleton([root, tip]));
      mesh.scale.set(1.2, 0.8, 1.3);
      scene.add(mesh);
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(2, 3, 5);
      scene.add(sun);
      return () => {
        tip.rotation.z = 0.55;
        mesh.position.x = 0.3;
        mesh.rotation.y = 0.2;
      };
    },
    'transparent-order': (scene) => {
      const group = new THREE.Group();
      group.renderOrder = 3;
      scene.add(group);
      const a = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 1.5),
        new THREE.MeshBasicMaterial({
          color: 0xdd6040,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          premultipliedAlpha: true,
        }),
      );
      const b = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 2),
        new THREE.MeshBasicMaterial({
          color: 0x4070dd,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
        }),
      );
      a.position.z = 0.2;
      group.add(a);
      scene.add(b);
      return () => {
        group.renderOrder = 0;
        b.renderOrder = 4;
        a.material.blending = THREE.AdditiveBlending;
      };
    },
    'custom-blending': (scene) => {
      scene.background = new THREE.Color(0x505050);
      const material = new THREE.MeshBasicMaterial({
        color: 0x80bc40,
        opacity: 0.6,
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendEquation: THREE.AddEquation,
      });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      return () => {
        material.blendEquation = THREE.ReverseSubtractEquation;
        material.blendSrc = THREE.SrcAlphaFactor;
      };
    },
    'opaque-opacity': (scene) => {
      const material = new THREE.MeshBasicMaterial({ color: 0x60b090, opacity: 0.2 });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      return () => {
        material.opacity = 0;
      };
    },
    'alpha-hash': (scene) => {
      const material = new THREE.MeshBasicMaterial({
        color: 0x60b090,
        opacity: 0.5,
        alphaHash: true,
      });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      return () => {
        material.opacity = 0.75;
      };
    },
  } satisfies Readonly<Record<string, (scene: ThreeCore.Scene) => () => void>>;
}
