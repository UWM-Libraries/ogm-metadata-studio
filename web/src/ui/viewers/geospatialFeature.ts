export type GeoJsonGeometry = {
    type: string;
    coordinates?: unknown;
    geometries?: GeoJsonGeometry[];
};

export interface SelectableGeoJsonFeature {
    id: string;
    rowIndex: number;
    properties: Record<string, unknown>;
    geometry: GeoJsonGeometry | null;
}
