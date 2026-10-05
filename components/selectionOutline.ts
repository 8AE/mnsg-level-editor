import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { GeometrySelection } from "./authoringState";

/** Outline the actual selected topology. Screen-space widths remain legible at any zoom. */
export function selectionSegments(
  geometry: THREE.BufferGeometry,
  choice: GeometrySelection,
): number[] {
  const positions = geometry.getAttribute("position"),
    indices = geometry.index;
  if (!positions || !indices || choice.mode === "vertex") return [];
  const result: number[] = [],
    seen = new Set<string>();
  const first = choice.mode === "face" ? choice.faceIndex * 3 : 0;
  const last = choice.mode === "face" ? first + 3 : indices.count;
  if (first < 0 || last > indices.count) return [];
  for (let face = first; face < last; face += 3) {
    const triangle = [0, 1, 2].map((at) => indices.getX(face + at));
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge],
        b = triangle[(edge + 1) % 3];
      const key = `${Math.min(a, b)}/${Math.max(a, b)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const at of [a, b])
        result.push(positions.getX(at), positions.getY(at), positions.getZ(at));
    }
  }
  return result;
}
export class SelectionOutline {
  readonly group = new THREE.Group();
  private readonly lines = [0x10141c, 0xffcf68].map((color, index) => {
    const line = new LineSegments2(
      new LineSegmentsGeometry(),
      new LineMaterial({
        color,
        linewidth: index ? 3 : 6,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    line.renderOrder = 40000 + index;
    line.frustumCulled = false;
    this.group.add(line);
    return line;
  });
  private readonly point = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      vertexShader:
        "void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_PointSize=20.0;}",
      fragmentShader:
        "void main(){float d=length(gl_PointCoord-vec2(0.5));if(d>0.5)discard;gl_FragColor=d>0.36?vec4(0.06,0.08,0.11,1.0):vec4(1.0,0.81,0.41,1.0);}",
    }),
  );
  constructor() {
    this.point.renderOrder = 40002;
    this.point.frustumCulled = false;
    this.group.add(this.point);
    this.group.visible = false;
  }
  update(
    surface: THREE.Mesh | undefined,
    choice: GeometrySelection | null | undefined,
    visible: boolean,
  ) {
    this.group.visible = Boolean(surface && choice && visible);
    if (!surface || !choice || !visible) return;
    this.group.matrix.copy(surface.matrixWorld);
    this.group.matrixAutoUpdate = false;
    this.point.visible = choice.mode === "vertex";
    if (choice.mode === "vertex") {
      const attr = surface.geometry.getAttribute("position"),
        at = choice.vertexIndex;
      this.point.visible = at >= 0 && at < attr.count;
      this.point.geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          this.point.visible
            ? [attr.getX(at), attr.getY(at), attr.getZ(at)]
            : [],
          3,
        ),
      );
    }
    const segments = selectionSegments(surface.geometry, choice);
    this.lines.forEach((line) => {
      line.visible = segments.length > 0;
      line.geometry.dispose();
      line.geometry = new LineSegmentsGeometry();
      if (segments.length) line.geometry.setPositions(segments);
    });
  }
  dispose() {
    this.lines.forEach((line) => {
      line.geometry.dispose();
      line.material.dispose();
    });
    this.point.geometry.dispose();
    this.point.material.dispose();
    this.group.removeFromParent();
  }
}
