import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hausdorff } from "../../scripts/quad-eval/fidelity.ts";
import type { EvalMesh, Vec3 } from "../../scripts/quad-eval/mesh.ts";
import { evaluate } from "../../scripts/quad-eval/metrics.ts";
import { extractFlowQuads } from "../../src/quad/flow-extract.ts";
import { instantMeshesField } from "../../src/quad/instant-meshes.ts";
import { solveIntegerOffsets } from "../../src/quad/integer-flow.ts";
import type { TriMesh } from "../../src/quad/trimesh.ts";
import { contactSheet, type PolyMesh, renderShape } from "../brep-kit/index.ts";
import {
	bracket,
	brepSphere,
	brepTorus,
	chamferBox,
	flangedTee,
	lumpy,
} from "../quad-field/models.ts";
import { alignedPositionField } from "./aligned-field.ts";

const OUT = resolve(
	process.argv[2] ?? join(tmpdir(), "forgeax-qflow-m5"),
);
const RENDERS = resolve(OUT, "renders");
mkdirSync(RENDERS, { recursive: true });

interface Subject {
	readonly id: string;
	readonly mesh: TriMesh;
	readonly field: "aligned" | "instant-meshes";
}

const subjects: readonly Subject[] = [
	{ id: "sphere", mesh: brepSphere(), field: "aligned" },
	{ id: "torus", mesh: brepTorus(), field: "aligned" },
	{ id: "torus-instant-meshes", mesh: brepTorus(), field: "instant-meshes" },
	{ id: "lumpy-sphere", mesh: lumpy(), field: "aligned" },
	{ id: "chamfer-box", mesh: chamferBox(), field: "aligned" },
	{ id: "bracket", mesh: bracket(), field: "aligned" },
	{ id: "flanged-tee", mesh: flangedTee(), field: "aligned" },
];

function evalInput(mesh: TriMesh): EvalMesh {
	const positions: Vec3[] = [];
	for (let i = 0; i < mesh.positions.length; i += 3)
		positions.push([
			mesh.positions[i] as number,
			mesh.positions[i + 1] as number,
			mesh.positions[i + 2] as number,
		]);
	const faces: number[][] = [];
	for (let i = 0; i < mesh.triangles.length; i += 3)
		faces.push([
			mesh.triangles[i] as number,
			mesh.triangles[i + 1] as number,
			mesh.triangles[i + 2] as number,
		]);
	return { positions, faces };
}

function polyMesh(
	positions: Float64Array,
	quads: Uint32Array,
	sharp: readonly (readonly [number, number])[],
): PolyMesh {
	const points: Vec3[] = [];
	for (let i = 0; i < positions.length; i += 3)
		points.push([
			positions[i] as number,
			positions[i + 1] as number,
			positions[i + 2] as number,
		]);
	const faces: number[][] = [];
	for (let i = 0; i < quads.length; i += 4)
		faces.push([
			quads[i] as number,
			quads[i + 1] as number,
			quads[i + 2] as number,
			quads[i + 3] as number,
		]);
	return { positions: points, faces, sharp };
}

function areaRatio(
	positions: Float64Array,
	quads: Uint32Array,
	input: TriMesh,
): number {
	const area = (a: Vec3, b: Vec3, c: Vec3): number => {
		const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
		const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
		const n: Vec3 = [
			u[1] * v[2] - u[2] * v[1],
			u[2] * v[0] - u[0] * v[2],
			u[0] * v[1] - u[1] * v[0],
		];
		return 0.5 * Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
	};
	let source = 0;
	for (let t = 0; t < input.triangles.length; t += 3)
		source += area(
			[
				input.positions[3 * (input.triangles[t] as number)] as number,
				input.positions[3 * (input.triangles[t] as number) + 1] as number,
				input.positions[3 * (input.triangles[t] as number) + 2] as number,
			],
			[
				input.positions[3 * (input.triangles[t + 1] as number)] as number,
				input.positions[3 * (input.triangles[t + 1] as number) + 1] as number,
				input.positions[3 * (input.triangles[t + 1] as number) + 2] as number,
			],
			[
				input.positions[3 * (input.triangles[t + 2] as number)] as number,
				input.positions[3 * (input.triangles[t + 2] as number) + 1] as number,
				input.positions[3 * (input.triangles[t + 2] as number) + 2] as number,
			],
		);
	let output = 0;
	for (let q = 0; q < quads.length; q += 4) {
		const point = (i: number): Vec3 => [
			positions[3 * i] as number,
			positions[3 * i + 1] as number,
			positions[3 * i + 2] as number,
		];
		const a = quads[q] as number;
		const b = quads[q + 1] as number;
		const c = quads[q + 2] as number;
		const d = quads[q + 3] as number;
		output +=
			area(point(a), point(b), point(c)) + area(point(a), point(c), point(d));
	}
	return source > 0 ? output / source : 0;
}

const summary: Record<string, unknown>[] = [];
const cells: {
	image: import("../brep-kit/image.ts").Image;
	caption: string;
}[] = [];
for (const subject of subjects) {
	const fieldResult =
		subject.field === "instant-meshes"
			? instantMeshesField(subject.mesh)
			: undefined;
	if (fieldResult !== undefined && !fieldResult.ok)
		throw new Error(
			`${subject.id}: field failed ${JSON.stringify(fieldResult.error)}`,
		);
	const field = fieldResult?.ok
		? fieldResult.value.field
		: alignedPositionField(subject.mesh, 0.1, 0.037);
	const flow = solveIntegerOffsets(field, { maxCapacity: 64 });
	if (!flow.ok) {
		summary.push({
			id: subject.id,
			status: "known-failure",
			reason:
				(flow.error.detail as { reason?: string } | undefined)?.reason ??
				flow.error.code,
			detail: flow.error.detail,
			fieldSource:
				subject.field === "aligned"
					? "self-generated aligned fixture"
					: "Instant Meshes field",
		});
		continue;
	}
	const extracted = extractFlowQuads(field, flow.value);
	if (!extracted.ok) {
		summary.push({
			id: subject.id,
			status: "known-failure",
			reason:
				(extracted.error.detail as { reason?: string } | undefined)?.reason ??
				extracted.error.code,
			detail: extracted.error.detail,
			integerFlow: flow.value.report,
			fieldSource:
				subject.field === "aligned"
					? "self-generated aligned fixture"
					: "Instant Meshes field",
		});
		continue;
	}
	const { mesh, report } = extracted.value;
	const output = polyMesh(mesh.positions, mesh.quads, mesh.sharp);
	const rendered = renderShape(output, {
		outDir: RENDERS,
		name: `${subject.id}-`,
		modes: ["network", "jacobian"],
		views: ["iso", "top", "side", "front"],
	});
	if (!rendered.ok)
		throw new Error(
			`${subject.id}: rendering failed ${JSON.stringify(rendered.error)}`,
		);
	for (const view of rendered.value.views)
		cells.push({
			image: view.image,
			caption: `${subject.id} ${view.mode} ${view.view}`,
		});

	const input = evalInput(subject.mesh);
	const outputEval: EvalMesh = {
		positions: output.positions,
		faces: output.faces,
	};
	const quality = evaluate(outputEval);
	const hausdorffSampled = hausdorff(input, outputEval, quality.diag);
	summary.push({
		id: subject.id,
		status: "extracted",
		fieldSource:
			subject.field === "aligned"
				? "self-generated aligned fixture"
				: "Instant Meshes field",
		integerFlow: flow.value.report,
		extraction: report,
		evaluation: {
			scaledJacobianMin: quality.scaledJacobian.min,
			inverted: quality.inverted.count,
			degenerate: quality.degenerate.count,
			valence3:
				quality.valence.interior.find((item) => item.valence === 3)?.count ?? 0,
			valence5:
				quality.valence.interior.find((item) => item.valence === 5)?.count ?? 0,
			areaRatio: areaRatio(mesh.positions, mesh.quads, subject.mesh),
			hausdorffSampledMax: hausdorffSampled.max,
			hausdorffSampledMean: hausdorffSampled.mean,
			hausdorffSampleCount: hausdorffSampled.samples,
			hausdorffSampleSpacing: hausdorffSampled.spacing,
		},
		renderPaths: rendered.value.views.map((view) => view.path),
	});
}

contactSheet(cells, {
	columns: 4,
	cell: 320,
	title: "Qflow integer-map quad extraction",
	path: resolve(OUT, "qflow-m5-sheet.png"),
});
writeFileSync(
	resolve(OUT, "metrics.json"),
	`${JSON.stringify(summary, null, 2)}\n`,
);
writeFileSync(
	resolve(OUT, "TORUS-NOTE.txt"),
	"Torus extraction remains unsupported. A closed integer-flow report is insufficient to prove one global per-vertex integer map: current edge offsets can still fail cycle consistency. Independently, the real Instant Meshes torus flow currently reaches integer-flow-capacity-limit. The next fix must reconcile joint per-face position ranks and signed edge-variable mapping before extraction can proceed.\n",
);
process.stdout.write(
	`${JSON.stringify({ output: OUT, renders: RENDERS, summary }, null, 2)}\n`,
);
