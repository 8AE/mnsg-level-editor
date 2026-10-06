import * as THREE from "three";

/** Camera-oriented world axes, drawn as vectors rather than inert axis buttons. */
export class SceneCompass {
  readonly element: SVGSVGElement;
  private axes: { group: SVGGElement; line: SVGLineElement; arrow: SVGPathElement; label: SVGTextElement; vector: THREE.Vector3 }[] = [];
  private inverse = new THREE.Quaternion();
  private last = "";
  constructor(document: Document) {
    const svg = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS("http://www.w3.org/2000/svg", tag);
    this.element = svg("svg");
    this.element.setAttribute("viewBox", "0 0 96 96");
    this.element.setAttribute("class", "scene-compass");
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "World orientation compass: X, Y and Z directions");
    this.element.dataset.testid = "scene-compass";
    for (const [index, axis] of ["x", "y", "z"].entries()) {
      const group = svg("g"), line = svg("line"), arrow = svg("path"), label = svg("text");
      group.setAttribute("class", `compass-axis compass-${axis}`);
      line.setAttribute("x1", "48");line.setAttribute("y1", "48");
      label.textContent = axis.toUpperCase();
      label.setAttribute("text-anchor", "middle");label.setAttribute("dominant-baseline", "central");
      group.append(line, arrow, label);this.element.append(group);
      this.axes.push({ group, line, arrow, label, vector: new THREE.Vector3().setComponent(index, 1) });
    }
    const origin = svg("circle");origin.setAttribute("cx", "48");origin.setAttribute("cy", "48");origin.setAttribute("r", "2");origin.setAttribute("class", "compass-origin");this.element.append(origin);
  }
  update(camera: THREE.Camera) {
    camera.getWorldQuaternion(this.inverse).invert();
    const key = this.inverse.toArray().map(v => v.toFixed(4)).join(",");
    if (key === this.last) return;this.last = key;
    const axes = this.axes.map(axis => ({ ...axis, direction: axis.vector.clone().applyQuaternion(this.inverse) })).sort((a, b) => a.direction.z - b.direction.z);
    for (const { group, line, arrow, label, direction: p } of axes) {
      const dx = p.x * 29, dy = -p.y * 29, length = Math.hypot(dx, dy), ux = length > .1 ? dx / length : 0, uy = length > .1 ? dy / length : -1;
      const x = 48 + dx, y = 48 + dy;
      line.setAttribute("x1", String(48 - dx * .6));line.setAttribute("y1", String(48 - dy * .6));
      line.setAttribute("x2", String(x));line.setAttribute("y2", String(y));
      arrow.setAttribute("d", `M ${x} ${y} L ${x - ux * 6 - uy * 3} ${y - uy * 6 + ux * 3} L ${x - ux * 6 + uy * 3} ${y - uy * 6 - ux * 3} Z`);
      label.setAttribute("x", String(x + ux * 10));label.setAttribute("y", String(y + uy * 10));
      group.style.opacity = p.z < 0 ? ".65" : "1";
      this.element.append(group);
    }
    this.element.dataset.orientation = axes.map(a => `${a.vector.toArray()}:${a.direction.toArray().map(v => v.toFixed(3))}`).join("|");
  }
}
