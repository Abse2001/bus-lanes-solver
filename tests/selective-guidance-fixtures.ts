import { fixedCopper } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

export const guidancePhysicalLayers = ["top", "inner1", "inner2", "bottom"]
export const guidanceWidth = 0.1016
const physical = guidancePhysicalLayers
const width = guidanceWidth,
  diameter = 0.4572,
  drill = 0.254

/** A real pair seals the only top escape and fullstack local via candidates.
 * Protecting the owned native wire changes the pair plan without retaining a guide. */
export function nativeWireBarrierFixture() {
  const physicalInput: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: width,
    minTraceToPadEdgeClearance: width,
    minViaPadDiameter: diameter,
    minViaHoleDiameter: drill,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -2.5, maxY: 3 },
    connections: [
      ...["P", "N"].map((name, index) => ({
        name,
        pointsToConnect: [-4.75, 4.75].map((x) => ({
          x,
          y: index ? 0.1108 : -0.1108,
          layer: "top",
        })),
      })),
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: -0.4, layer: "top" },
          { x: 2, y: 0.8, layer: "top" },
        ],
      },
      {
        name: "fixed_power",
        pointsToConnect: [
          { x: -3.6, y: -1.8, layer: "top" },
          { x: -2, y: -1.8, layer: "top" },
        ],
      },
    ],
    buses: [
      { busId: "DATA", connectionNames: ["D"], maxLengthSkew: 0.635 },
      { busId: "PAIR", connectionNames: ["P", "N"], maxLengthSkew: 0.635 },
    ],
    differentialPairs: [
      { connectionNames: ["P", "N"], traceGap: 0.12, lengthTolerance: 0.127 },
    ],
    obstacles: [
      ...["P", "N"].flatMap((name, index) =>
        [-4.75, 4.75].map((x) => ({
          shape: "circle" as const,
          type: "rect",
          componentId: x < 0 ? "pair_left" : "pair_right",
          center: { x, y: index ? 0.1108 : -0.1108 },
          width: 0.1,
          height: 0.1,
          layers: ["top"],
          connectedTo: [name],
        })),
      ),
      ...[
        { x: 0, y: -0.4, componentId: "data_left", name: "D" },
        { x: 0.8, y: -0.4, componentId: "data_left", name: "foreign_left" },
        { x: 2, y: 0.8, componentId: "data_right", name: "D" },
        { x: 2.8, y: 0.8, componentId: "data_right", name: "foreign_right" },
      ].map(({ x, y, componentId, name }) => ({
        shape: "circle" as const,
        type: "rect",
        componentId,
        center: { x, y },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: [name],
      })),
      {
        type: "rect",
        center: { x: 0, y: -1.25 },
        width: 4.5,
        height: 2.5,
        layers: ["inner1", "inner2", "bottom"],
        connectedTo: ["fixed_power"],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "immutable_power",
        connection_name: "fixed_power",
        source_trace_id: "fixed_power",
        route: [
          { route_type: "wire", x: -3.6, y: -1.8, layer: "top", width },
          { route_type: "wire", x: -3, y: -1.8, layer: "top", width },
          {
            route_type: "via",
            x: -3,
            y: -1.8,
            from_layer: "top",
            to_layer: "bottom",
            layers: physical,
            via_diameter: diameter,
            via_hole_diameter: drill,
          },
          { route_type: "wire", x: -3, y: -1.8, layer: "bottom", width },
          { route_type: "wire", x: -2.6, y: -1.8, layer: "bottom", width },
          {
            route_type: "via",
            x: -2.6,
            y: -1.8,
            from_layer: "bottom",
            to_layer: "top",
            layers: physical,
            via_diameter: diameter,
            via_hole_diameter: drill,
          },
          { route_type: "wire", x: -2.6, y: -1.8, layer: "top", width },
          { route_type: "wire", x: -2, y: -1.8, layer: "top", width },
        ],
      },
    ],
  }
  const original = (
    end: number,
    x: number,
    fromY: number,
    viaY: number,
  ): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `owned_D_${end}`,
    connection_name: "D",
    source_trace_id: "D",
    route: [
      { route_type: "wire", x, y: fromY, layer: "top", width },
      { route_type: "wire", x, y: viaY, layer: "top", width },
      {
        route_type: "via",
        x,
        y: viaY,
        from_layer: "top",
        to_layer: "bottom",
        layers: physical,
        via_diameter: diameter,
        via_hole_diameter: drill,
      },
      { route_type: "wire", x, y: viaY, layer: "bottom", width },
    ],
  })
  const originals = [original(0, 0, -0.4, 0.8), original(1, 2, 0.8, 1.6)]

  const native = {
    ...physicalInput,
    connections: physicalInput.connections.filter(
      (connection) => connection.name !== "fixed_power",
    ),
  }
  return { native, physicalInput, originals }
}

/** Every finite option pair clashes at the CPU via, while all RAM sites differ.
 * RAM-only repair is physically irrelevant; the alternate CPU landing is valid. */
export function jointCpuConflictFixture() {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: width,
    minTraceToPadEdgeClearance: width,
    minViaPadDiameter: diameter,
    minViaHoleDiameter: drill,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 9, minY: -2, maxY: 3 },
    differentialPairs: [
      { connectionNames: ["P", "N"], traceGap: 0.12, lengthTolerance: 0.127 },
    ],
    connections: [
      {
        name: "A",
        pointsToConnect: [
          { x: -0.4, y: 0, layer: "top" },
          { x: 6, y: 0, layer: "top" },
        ],
      },
      {
        name: "B",
        pointsToConnect: [
          { x: 0.4, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
      ...["P", "N"].map((name, index) => ({
        name,
        pointsToConnect: [-4, 8].map((x) => ({
          x,
          y: 0.8 + (index ? 0.1108 : -0.1108),
          layer: "top",
        })),
      })),
      {
        name: "fixed_power",
        pointsToConnect: [
          { x: -3.6, y: -1.4, layer: "top" },
          { x: -2, y: -1.4, layer: "bottom" },
        ],
      },
    ],
    obstacles: [
      ...[
        { x: -0.4, name: "A" },
        { x: 0.4, name: "B" },
        { x: 6, name: "A" },
        { x: 3, name: "B" },
      ].map(({ x, name }) => ({
        type: "rect",
        shape: "circle" as const,
        center: { x, y: 0 },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: [name],
      })),
      ...["P", "N"].flatMap((name, index) =>
        [-4, 8].map((x) => ({
          type: "rect",
          shape: "circle" as const,
          center: { x, y: 0.8 + (index ? 0.1108 : -0.1108) },
          width: 0.1,
          height: 0.1,
          layers: ["top"],
          connectedTo: [name],
        })),
      ),
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "immutable_power",
        connection_name: "fixed_power",
        source_trace_id: "fixed_power",
        route: [
          { route_type: "wire", x: -3.6, y: -1.4, layer: "top", width },
          { route_type: "wire", x: -3, y: -1.4, layer: "top", width },
          {
            route_type: "via",
            x: -3,
            y: -1.4,
            from_layer: "top",
            to_layer: "bottom",
            layers: physical,
            via_diameter: diameter,
            via_hole_diameter: drill,
          },
          { route_type: "wire", x: -3, y: -1.4, layer: "bottom", width },
          { route_type: "wire", x: -2, y: -1.4, layer: "bottom", width },
        ],
      },
    ],
  }
  const escape = (
    name: string,
    end: number,
    startX: number,
    viaX: number,
    viaY: number,
  ): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `owned_${name}_${end}_${viaX}_${viaY}`,
    connection_name: name,
    source_trace_id: name,
    route: [
      { route_type: "wire", x: startX, y: 0, layer: "top", width },
      { route_type: "wire", x: viaX, y: viaY, layer: "top", width },
      {
        route_type: "via",
        x: viaX,
        y: viaY,
        from_layer: "top",
        to_layer: "bottom",
        layers: physical,
        via_diameter: diameter,
        via_hole_diameter: drill,
      },
      { route_type: "wire", x: viaX, y: viaY, layer: "bottom", width },
    ],
  })
  const pair: Trace[] = ["P", "N"].map((name, index) => ({
    type: "pcb_trace",
    pcb_trace_id: `generated_pair_${name}`,
    connection_name: name,
    source_trace_id: name,
    route: [-4, 8].map((x) => ({
      route_type: "wire" as const,
      x,
      y: 0.8 + (index ? 0.1108 : -0.1108),
      layer: "top",
      width,
    })),
  }))
  const originals = [
    escape("A", 0, -0.4, 0, 0.4),
    escape("A", 1, 6, 6, 1.2),
    escape("B", 0, 0.4, 0.4, 1.2),
    escape("B", 1, 3, 3, 0.4),
  ]
  const variants = new Map(
    ["A", "B"].map((name) => [
      name,
      [0, 0.4].map((offset) => {
        const escapes = [
          escape(name, 0, name === "A" ? -0.4 : 0.4, 0, 0.4),
          escape(
            name,
            1,
            name === "A" ? 6 : 3,
            (name === "A" ? 6 : 3) + offset,
            0.4,
          ),
        ]
        return {
          escapes,
          escapeCopper: fixedCopper({
            ...native,
            obstacles: [],
            traces: escapes,
          }),
        }
      }),
    ]),
  )

  return {
    native: {
      ...native,
      connections: native.connections.filter(
        (connection) => connection.name !== "fixed_power",
      ),
    },
    physicalInput: native,
    originals,
    variants,
    pair,
  }
}

/** Initially every pair has a compatible CPU landing, but A and C force
 * opposite choices in B. Full manufactured escapes provide the contradiction. */
export function propagatingCpuSiteConflictFixture() {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: width,
    minTraceToPadEdgeClearance: width,
    minViaPadDiameter: diameter,
    minViaHoleDiameter: drill,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -3.5, maxX: 3.5, minY: -1, maxY: 5 },
    connections: ["A", "B", "C"].map((name, i) => ({
      name,
      pointsToConnect: [0, 3].map((y) => ({ x: (i - 1) * 2, y, layer: "top" })),
    })),
    obstacles: ["A", "B", "C"].flatMap((name, i) =>
      [0, 3].map((y) => ({
        type: "rect",
        shape: "circle" as const,
        center: { x: (i - 1) * 2, y },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: [name],
      })),
    ),
  }
  const approach = (
    name: string,
    x: number,
    y: number,
    viaX: number,
  ): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `owned_${name}_${y}_${viaX}`,
    connection_name: name,
    source_trace_id: name,
    route: [
      { route_type: "wire", x, y, layer: "top", width },
      { route_type: "wire", x: viaX, y: y + 0.8, layer: "top", width },
      {
        route_type: "via",
        x: viaX,
        y: y + 0.8,
        from_layer: "top",
        to_layer: "bottom",
        layers: physical,
        via_diameter: diameter,
        via_hole_diameter: drill,
      },
      { route_type: "wire", x: viaX, y: y + 0.8, layer: "bottom", width },
    ],
  })
  const domains = ["A", "B", "C"].map((name, i) => ({
    name,
    options: (name === "A" ? [-1] : name === "C" ? [1] : [-1, 1]).map(
      (viaX) => {
        const escapes = [
          approach(name, (i - 1) * 2, 0, viaX),
          approach(name, (i - 1) * 2, 3, (i - 1) * 2),
        ]
        return {
          escapes,
          escapeCopper: fixedCopper({
            ...native,
            obstacles: [],
            traces: escapes,
          }),
        }
      },
    ),
  }))
  return { native, domains }
}
