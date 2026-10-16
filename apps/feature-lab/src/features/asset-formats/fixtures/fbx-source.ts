/** ASCII FBX 7.4: one triangle mesh with a Phong and a Lambert material. */
const material = (
  id: number,
  name: string,
  model: string,
  props: readonly string[],
): string => `    Material: ${id}, "Material::${name}", "" {
        Version: 102
        ShadingModel: "${model}"
        Properties70:  {
${props.map((p) => `            ${p}`).join('\n')}
        }
    }`;
export const TRIANGLE_FBX = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
    FBXHeaderVersion: 1003
    FBXVersion: 7400
}
GlobalSettings:  {
    Version: 1000
    Properties70:  {
        P: "UpAxis", "int", "Integer", "", 1
        P: "UnitScaleFactor", "double", "Number", "", 1
    }
}
Objects:  {
    Geometry: 1001, "Geometry::Tri", "Mesh" {
        GeometryVersion: 124
        Vertices: *9 {
            a: -1, -1, 0, 1, -1, 0, 0, 1, 0
        }
        PolygonVertexIndex: *3 {
            a: 0, 1, -3
        }
        LayerElementMaterial: 0 {
            Version: 101
            MappingInformationType: "AllSame"
            ReferenceInformationType: "IndexToDirect"
            Materials: *1 {
                a: 0
            }
        }
        Layer: 0 {
            Version: 100
            LayerElement:  {
                Type: "LayerElementMaterial"
                TypedIndex: 0
            }
        }
    }
    Model: 2001, "Model::Tri", "Mesh" {
        Version: 232
    }
${material(3001, 'Shiny', 'phong', ['P: "DiffuseColor", "Color", "", "A", 0.9, 0.1, 0.1', 'P: "Shininess", "Number", "", "A", 25'])}
${material(3002, 'Matte', 'lambert', ['P: "DiffuseColor", "Color", "", "A", 0.1, 0.8, 0.2'])}
}
Connections:  {
    C: "OO", 2001, 0
    C: "OO", 1001, 2001
    C: "OO", 3001, 2001
    C: "OO", 3002, 2001
}
`;

export const TRIANGLE_FBX_BYTES = new TextEncoder().encode(TRIANGLE_FBX);
