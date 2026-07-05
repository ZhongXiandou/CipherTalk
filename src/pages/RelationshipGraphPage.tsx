import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import { Avatar, Button, Chip, Drawer, Label, Popover, ScrollShadow, SearchField, Slider, Spinner, Switch } from '@heroui/react'
import { ArrowsRotateLeft, ChartBar, Link, Magnifier, NodesRight, Person, Sliders } from '@gravity-ui/icons'
import type {
  RelationshipGraphBuildProgress,
  RelationshipGraphCommunity,
  RelationshipGraphLink,
  RelationshipGraphNode,
  RelationshipGraphOptions,
  RelationshipGraphPathResult,
  RelationshipGraphPartialResult,
  RelationshipGraphRelationType,
  RelationshipGraphResult,
} from '../types/models'
import DateRangePicker from '../components/DateRangePicker'
import { createLiquidGlassMap, type GlassFilterMap, type GlassShapeOptions } from '../utils/liquidGlass'
import './RelationshipGraphPage.css'

type GraphNodeObject = RelationshipGraphNode & { x?: number; y?: number; z?: number }
type GraphLinkObject = Omit<RelationshipGraphLink, 'source' | 'target'> & {
  source: string | GraphNodeObject
  target: string | GraphNodeObject
}
type FlowParticleItem = {
  object: THREE.Group
  link: GraphLinkObject
  progress: number
  speed: number
  highlighted: boolean
  selected: boolean
}
type FlowParticleStore = {
  group: THREE.Group
  items: Map<string, FlowParticleItem>
}

const RELATION_LABELS: Record<RelationshipGraphRelationType, string> = {
  direct_chat: '私聊',
  same_group: '同群',
  group_interaction: '群内互动',
}

const RELATION_COLORS: Record<RelationshipGraphRelationType, string> = {
  direct_chat: '#73b7ff',
  same_group: '#4fd7c5',
  group_interaction: '#ffcf75',
}

const MAX_VISIBLE_LINKS = 6500
const MAX_SEARCH_LINKS = 12000
const LINK_CURVE_SEGMENTS = 18
const NODE_VISIBLE_RADIUS_RATIO = 0.34
const spriteCache = new Map<string, THREE.Sprite>()
const linkMaterialCache = new Map<string, THREE.Material>()
const particleCoreGeometry = new THREE.SphereGeometry(1, 12, 8)
const particleHaloGeometry = new THREE.SphereGeometry(1, 16, 10)
const TOOLBAR_GLASS_SHAPE: GlassShapeOptions = {
  halfX: 0.5,
  halfY: 0.5,
  radius: 0.2,
  edge: 0.08,
  feather: 0.62,
  strength: 1.18,
  edgeStrength: 0.9,
}

const toSliderNumber = (value: number | number[]): number => Array.isArray(value) ? value[0] ?? 0 : value

function endpointId(value: string | GraphNodeObject): string {
  return typeof value === 'string' ? value : value.id
}

function formatCount(value?: number): string {
  const n = Number(value || 0)
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatTime(seconds?: number): string {
  if (!seconds) return '未知'
  return new Date(seconds * 1000).toLocaleDateString()
}

function linkPairKey(link: Pick<GraphLinkObject, 'source' | 'target'>): string {
  const source = endpointId(link.source)
  const target = endpointId(link.target)
  return source < target ? `${source}::${target}` : `${target}::${source}`
}

function linkWeightLevel(link: Pick<GraphLinkObject, 'weight'>): 'weak' | 'medium' | 'strong' {
  const weight = Number(link.weight || 0)
  if (weight >= 18) return 'strong'
  if (weight >= 7) return 'medium'
  return 'weak'
}

function linkOpacityFor(link: GraphLinkObject, highlighted: boolean, selected: boolean): number {
  if (selected) return 0.95
  if (highlighted) return 0.82
  const level = linkWeightLevel(link)
  if (link.type === 'same_group') return level === 'strong' ? 0.22 : level === 'medium' ? 0.14 : 0.055
  if (link.type === 'group_interaction') return level === 'strong' ? 0.38 : level === 'medium' ? 0.26 : 0.13
  return level === 'strong' ? 0.48 : level === 'medium' ? 0.32 : 0.16
}

function linkMaterialFor(link: GraphLinkObject, highlighted: boolean, selected: boolean): THREE.Material {
  const color = selected || highlighted ? '#ffffff' : RELATION_COLORS[link.type] || '#9ca3af'
  const opacity = linkOpacityFor(link, highlighted, selected)
  const cacheKey = `${color}:${opacity.toFixed(3)}`
  const cached = linkMaterialCache.get(cacheKey)
  if (cached) return cached
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: highlighted || selected ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  linkMaterialCache.set(cacheKey, material)
  return material
}

function linkWidthFor(link: GraphLinkObject, highlighted: boolean, selected: boolean): number {
  if (selected) return 2.6
  if (highlighted) return 2.1
  const level = linkWeightLevel(link)
  if (link.type === 'same_group') return level === 'strong' ? 0.42 : level === 'medium' ? 0.24 : 0.08
  if (link.type === 'group_interaction') return level === 'strong' ? 0.72 : level === 'medium' ? 0.44 : 0.18
  return level === 'strong' ? 0.95 : level === 'medium' ? 0.58 : 0.24
}

function linkCurvatureFor(link: GraphLinkObject, highlighted: boolean, selected: boolean): number {
  if (selected) return 0.22
  if (highlighted) return 0.18
  if (link.type === 'same_group') return 0.085
  if (link.type === 'group_interaction') return 0.055
  return 0.025
}

function particleMaterialFor(color: string, opacity: number): THREE.MeshBasicMaterial {
  const cacheKey = `particle:${color}:${opacity.toFixed(2)}`
  const cached = linkMaterialCache.get(cacheKey) as THREE.MeshBasicMaterial | undefined
  if (cached) return cached
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  })
  linkMaterialCache.set(cacheKey, material)
  return material
}

function makeLinkParticle(link: GraphLinkObject, highlighted: boolean, selected: boolean): THREE.Group {
  const color = highlighted || selected ? '#ffffff' : RELATION_COLORS[link.type] || '#ffffff'
  const group = new THREE.Group()
  const scale = highlighted ? 1.15 : selected ? 0.95 : 0.78
  const halo = new THREE.Mesh(particleHaloGeometry, particleMaterialFor(color, highlighted ? 0.16 : 0.12))
  const core = new THREE.Mesh(particleCoreGeometry, particleMaterialFor('#ffffff', highlighted ? 0.92 : 0.78))
  halo.scale.setScalar(scale)
  core.scale.setScalar(scale * 0.28)
  group.add(halo, core)
  return group
}

function linkCurveFromNodes(link: GraphLinkObject, highlighted: boolean, selected: boolean): THREE.QuadraticBezierCurve3 | null {
  if (typeof link.source === 'string' || typeof link.target === 'string') return null
  if (link.source.x == null || link.source.y == null || link.source.z == null) return null
  if (link.target.x == null || link.target.y == null || link.target.z == null) return null

  const start = new THREE.Vector3(link.source.x, link.source.y, link.source.z)
  const end = new THREE.Vector3(link.target.x, link.target.y, link.target.z)
  const delta = new THREE.Vector3().subVectors(end, start)
  const length = delta.length()
  if (length <= 0.001) return null

  const direction = delta.clone().normalize()
  const startRadius = Math.min(length * 0.42, nodeLinkRadius(link.source))
  const endRadius = Math.min(length * 0.42, nodeLinkRadius(link.target))
  const edgeStart = start.clone().add(direction.clone().multiplyScalar(startRadius))
  const edgeEnd = end.clone().add(direction.clone().multiplyScalar(-endRadius))
  const edgeDelta = new THREE.Vector3().subVectors(edgeEnd, edgeStart)
  const edgeLength = Math.max(0.001, edgeDelta.length())
  const midpoint = new THREE.Vector3().addVectors(edgeStart, edgeEnd).multiplyScalar(0.5)
  const normal = edgeDelta.clone()
    .cross(Math.abs(edgeDelta.y) > Math.abs(edgeDelta.x) ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0))
    .normalize()
  const control = midpoint.add(normal.multiplyScalar(edgeLength * linkCurvatureFor(link, highlighted, selected)))
  return new THREE.QuadraticBezierCurve3(edgeStart, control, edgeEnd)
}

function nodeSpriteScale(node: RelationshipGraphNode): number {
  return Math.max(10, Math.min(26, 8 + Math.sqrt(Math.max(1, node.weightedDegree || 1)) * 1.8))
}

function nodeLinkRadius(node: string | GraphNodeObject | undefined): number {
  if (!node || typeof node === 'string') return 4
  return Math.max(3, nodeSpriteScale(node) * NODE_VISIBLE_RADIUS_RATIO)
}

function linkLineMaterialFor(link: GraphLinkObject, highlighted: boolean, selected: boolean): THREE.LineBasicMaterial {
  const color = selected || highlighted ? '#ffffff' : RELATION_COLORS[link.type] || '#9ca3af'
  const opacity = linkOpacityFor(link, highlighted, selected)
  const cacheKey = `line:${color}:${opacity.toFixed(3)}`
  const cached = linkMaterialCache.get(cacheKey) as THREE.LineBasicMaterial | undefined
  if (cached) return cached
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: highlighted || selected ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  linkMaterialCache.set(cacheKey, material)
  return material
}

function makeLinkLine(link: GraphLinkObject): THREE.Line {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LINK_CURVE_SEGMENTS + 1) * 3), 3))
  return new THREE.Line(geometry, linkLineMaterialFor(link, false, false))
}

function updateLinkLinePosition(
  object: THREE.Object3D,
  coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
  link: GraphLinkObject,
  highlighted: boolean,
  selected: boolean
): boolean {
  const line = object as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  if (!line.geometry?.getAttribute('position')) return false

  line.material = linkLineMaterialFor(link, highlighted, selected)

  const start = new THREE.Vector3(coords.start.x || 0, coords.start.y || 0, coords.start.z || 0)
  const end = new THREE.Vector3(coords.end.x || 0, coords.end.y || 0, coords.end.z || 0)
  const delta = new THREE.Vector3().subVectors(end, start)
  const length = delta.length()
  const position = line.geometry.getAttribute('position') as THREE.BufferAttribute

  if (length <= 0.001) return true

  const direction = delta.clone().normalize()
  const startRadius = Math.min(length * 0.42, nodeLinkRadius(link.source))
  const endRadius = Math.min(length * 0.42, nodeLinkRadius(link.target))
  const edgeStart = start.clone().add(direction.clone().multiplyScalar(startRadius))
  const edgeEnd = end.clone().add(direction.clone().multiplyScalar(-endRadius))
  const edgeDelta = new THREE.Vector3().subVectors(edgeEnd, edgeStart)
  const edgeLength = Math.max(0.001, edgeDelta.length())
  const midpoint = new THREE.Vector3().addVectors(edgeStart, edgeEnd).multiplyScalar(0.5)
  const curvature = linkCurvatureFor(link, highlighted, selected)
  const normal = edgeDelta.clone()
    .cross(Math.abs(edgeDelta.y) > Math.abs(edgeDelta.x) ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0))
    .normalize()
  const control = midpoint.add(normal.multiplyScalar(edgeLength * curvature))
  const curve = new THREE.QuadraticBezierCurve3(edgeStart, control, edgeEnd)
  const points = curve.getPoints(LINK_CURVE_SEGMENTS)

  for (let i = 0; i < points.length; i += 1) {
    position.setXYZ(i, points[i].x, points[i].y, points[i].z)
  }
  position.needsUpdate = true
  line.geometry.computeBoundingSphere()
  return true
}

function dateToSeconds(value: string, endOfDay = false): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const time = Math.floor(date.getTime() / 1000)
  return Number.isFinite(time) ? time : undefined
}

function normalizeGraphSeconds(value?: number): number | undefined {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function assignClientNodeMetrics(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  for (const node of nodes) {
    node.degree = 0
    node.weightedDegree = 0
  }
  for (const link of links) {
    const source = nodeMap.get(String(link.source))
    const target = nodeMap.get(String(link.target))
    if (!source || !target) continue
    source.degree += 1
    target.degree += 1
    source.weightedDegree = Number((source.weightedDegree + Number(link.weight || 0)).toFixed(3))
    target.weightedDegree = Number((target.weightedDegree + Number(link.weight || 0)).toFixed(3))
    const last = normalizeGraphSeconds(link.lastActiveTime)
    if (last) {
      source.lastActiveTime = Math.max(Number(source.lastActiveTime || 0), last)
      target.lastActiveTime = Math.max(Number(target.lastActiveTime || 0), last)
    }
  }
}

function buildClientCommunities(nodes: RelationshipGraphNode[]): RelationshipGraphCommunity[] {
  const map = new Map<string, RelationshipGraphCommunity>()
  for (const node of nodes) {
    const id = node.communityId || 'c0'
    const item = map.get(id) || { id, label: `社群 ${id.replace(/^c/, '')}`, size: 0, weight: 0 }
    item.size += 1
    item.weight = Number((item.weight + Number(node.weightedDegree || 0)).toFixed(3))
    map.set(id, item)
  }
  return Array.from(map.values()).sort((a, b) => b.size - a.size)
}

function buildClientSimilar(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): Record<string, RelationshipGraphNode[]> {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const neighbors = new Map<string, Set<string>>()
  for (const node of nodes) neighbors.set(node.id, new Set())
  for (const link of links) {
    const source = String(link.source)
    const target = String(link.target)
    neighbors.get(source)?.add(target)
    neighbors.get(target)?.add(source)
  }

  const result: Record<string, RelationshipGraphNode[]> = {}
  const anchors = [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 80)
  for (const anchor of anchors) {
    const anchorNeighbors = neighbors.get(anchor.id) || new Set()
    if (anchorNeighbors.size === 0) continue
    const scored = nodes
      .filter(node => node.id !== anchor.id)
      .map(node => {
        const otherNeighbors = neighbors.get(node.id) || new Set()
        let intersection = 0
        for (const id of anchorNeighbors) if (otherNeighbors.has(id)) intersection += 1
        const union = new Set([...anchorNeighbors, ...otherNeighbors]).size || 1
        return { node, score: intersection / union }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.node.weightedDegree - a.node.weightedDegree)
      .slice(0, 6)
      .map(item => nodeMap.get(item.node.id)!)
    if (scored.length) result[anchor.id] = scored
  }
  return result
}

function filterRelationshipGraphResult(input: RelationshipGraphResult, options: RelationshipGraphOptions): RelationshipGraphResult {
  if (!input.success || !input.nodes || !input.links) return input

  const isPreview = Boolean((input as RelationshipGraphPartialResult).preview)
  const relationTypes = new Set(options.relationTypes || ['direct_chat', 'same_group', 'group_interaction'])
  const startTime = normalizeGraphSeconds(options.startTime)
  const endTime = normalizeGraphSeconds(options.endTime)
  const minWeight = Math.max(0, Number(options.minWeight || 0))
  const query = String(options.query || '').trim().toLowerCase()

  let links: RelationshipGraphLink[] = input.links
    .map(link => ({
      ...link,
      source: endpointId(link.source as string | GraphNodeObject),
      target: endpointId(link.target as string | GraphNodeObject),
      evidenceSessionIds: [...(link.evidenceSessionIds || [])],
    }))
    .filter(link => {
      if (!relationTypes.has(link.type)) return false
      if (Number(link.weight || 0) < minWeight) return false
      const last = normalizeGraphSeconds(link.lastActiveTime)
      if (startTime && (!last || last < startTime)) return false
      if (endTime && (!last || last > endTime)) return false
      return true
    })

  const connectedIds = new Set<string>()
  for (const link of links) {
    connectedIds.add(String(link.source))
    connectedIds.add(String(link.target))
  }

  let nodes = input.nodes
    .map(node => ({ ...node }))
    .filter(node => options.includeIsolated !== false || connectedIds.has(node.id))

  if (options.communityId) {
    const allowed = new Set(nodes.filter(node => node.communityId === options.communityId).map(node => node.id))
    nodes = nodes.filter(node => allowed.has(node.id))
    links = links.filter(link => allowed.has(String(link.source)) && allowed.has(String(link.target)))
  }

  if (query) {
    const matching = new Set(nodes
      .filter(node => node.label.toLowerCase().includes(query) || node.id.toLowerCase().includes(query))
      .map(node => node.id))
    const expanded = new Set(matching)
    for (const link of links) {
      const source = String(link.source)
      const target = String(link.target)
      if (matching.has(source)) expanded.add(target)
      if (matching.has(target)) expanded.add(source)
    }
    nodes = nodes.filter(node => expanded.has(node.id))
    links = links.filter(link => expanded.has(String(link.source)) && expanded.has(String(link.target)))
  }

  const nodeIds = new Set(nodes.map(node => node.id))
  links = links.filter(link => nodeIds.has(String(link.source)) && nodeIds.has(String(link.target)))
  assignClientNodeMetrics(nodes, links)
  const communities = buildClientCommunities(nodes)

  return {
    ...input,
    nodes,
    links,
    communities,
    rankings: {
      central: [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 24),
      isolated: nodes.filter(node => node.degree === 0).sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0)).slice(0, 24),
      active: [...nodes].sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0)).slice(0, 24),
    },
    similar: isPreview ? {} : buildClientSimilar(nodes, links),
    stats: {
      nodeCount: nodes.length,
      linkCount: links.length,
      directChatCount: links.filter(link => link.type === 'direct_chat').length,
      sameGroupCount: links.filter(link => link.type === 'same_group').length,
      groupInteractionCount: links.filter(link => link.type === 'group_interaction').length,
      isolatedCount: nodes.filter(node => node.degree === 0).length,
      communityCount: communities.length,
      builtAt: input.stats?.builtAt || Date.now(),
      stale: input.stats?.stale ?? false,
    },
  }
}

function makeNodeSprite(node: RelationshipGraphNode): THREE.Sprite {
  const cacheKey = `${node.id}:${node.avatarUrl || ''}:${node.label}`
  const cached = spriteCache.get(cacheKey)
  if (cached) return cached.clone()

  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)

  const drawBase = () => {
    ctx.clearRect(0, 0, size, size)
    ctx.shadowColor = 'rgba(0, 0, 0, .28)'
    ctx.shadowBlur = 16
    ctx.shadowOffsetY = 8
    const gradient = ctx.createLinearGradient(0, 0, size, size)
    gradient.addColorStop(0, node.kind === 'self' ? '#38bdf8' : node.kind === 'group_member' ? '#f59e0b' : '#34d399')
    gradient.addColorStop(1, node.kind === 'self' ? '#2563eb' : node.kind === 'group_member' ? '#ef4444' : '#6366f1')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(64, 64, 46, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
  }

  const drawFallback = () => {
    drawBase()
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 42px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((node.label || node.id).slice(0, 1).toUpperCase(), 64, 65)
    texture.needsUpdate = true
  }

  drawFallback()
  if (node.avatarUrl) {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      ctx.clearRect(0, 0, size, size)
      ctx.shadowColor = 'rgba(0, 0, 0, .28)'
      ctx.shadowBlur = 16
      ctx.shadowOffsetY = 8
      ctx.fillStyle = '#000000'
      ctx.beginPath()
      ctx.arc(64, 64, 46, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
      ctx.save()
      ctx.beginPath()
      ctx.arc(64, 64, 44, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(image, 20, 20, 88, 88)
      ctx.restore()
      texture.needsUpdate = true
    }
    image.onerror = drawFallback
    image.src = node.avatarUrl
  }

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  const scale = nodeSpriteScale(node)
  sprite.scale.set(scale, scale, 1)
  spriteCache.set(cacheKey, sprite)
  return sprite.clone()
}

function RelationshipGraphPage() {
  const graphRef = useRef<any>(null)
  const graphContainerRef = useRef<HTMLElement | null>(null)
  const flowParticlesRef = useRef<FlowParticleStore | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const partialResultRef = useRef<RelationshipGraphPartialResult | null>(null)
  const [toolbarGlassId] = useState(() => `relationship-toolbar-glass-${Math.random().toString(36).slice(2, 9)}`)
  const [toolbarGlassMap, setToolbarGlassMap] = useState<GlassFilterMap | null>(null)
  const [result, setResult] = useState<RelationshipGraphResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [progress, setProgress] = useState<RelationshipGraphBuildProgress | null>(null)
  const [graphSize, setGraphSize] = useState({ width: 1, height: 1 })
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [minWeight, setMinWeight] = useState(0)
  const [includeIsolated, setIncludeIsolated] = useState(false)
  const [relationTypes, setRelationTypes] = useState<RelationshipGraphRelationType[]>(['direct_chat', 'same_group', 'group_interaction'])
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedNode, setSelectedNode] = useState<RelationshipGraphNode | null>(null)
  const [selectedLink, setSelectedLink] = useState<RelationshipGraphLink | null>(null)
  const [pathSource, setPathSource] = useState<RelationshipGraphNode | null>(null)
  const [pathTarget, setPathTarget] = useState<RelationshipGraphNode | null>(null)
  const [pathResult, setPathResult] = useState<RelationshipGraphPathResult | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)

  const options = useMemo<RelationshipGraphOptions>(() => ({
    query: query.trim() || undefined,
    minWeight,
    relationTypes,
    includeIsolated,
    startTime: dateToSeconds(startDate),
    endTime: dateToSeconds(endDate, true),
  }), [endDate, includeIsolated, minWeight, query, relationTypes, startDate])
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
    if (partialResultRef.current) {
      setResult(filterRelationshipGraphResult(partialResultRef.current, options))
    }
  }, [options])

  const loadGraph = useCallback(async (force = false) => {
    setLoading(true)
    setProgress(null)
    setError('')
    setPathResult(null)
    try {
      const next = force
        ? await window.electronAPI.relationshipGraph.rebuild(options)
        : await window.electronAPI.relationshipGraph.getGraph(options)
      if (!next.stats?.stale) {
        partialResultRef.current = null
      }
      setPreviewing(Boolean(next.stats?.stale))
      setResult(next)
      if (!next.success) setError(next.error || '关系网络加载失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPreviewing(false)
    } finally {
      setLoading(false)
    }
  }, [options])

  useEffect(() => {
    const off = window.electronAPI.relationshipGraph.onProgress((next) => {
      setProgress(next)
      if (next.stage === 'done' || next.stage === 'error') setPreviewing(false)
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.electronAPI.relationshipGraph.onPartial((partial) => {
      partialResultRef.current = partial
      setPreviewing(partial.preview)
      if (partial.success) {
        setError('')
        setResult(filterRelationshipGraphResult(partial, optionsRef.current))
      } else {
        setError(partial.error || '关系网络加载失败')
      }
      if (!partial.preview) setLoading(false)
    })
    return off
  }, [])

  useEffect(() => {
    const element = graphContainerRef.current
    if (!element) return

    const syncSize = () => {
      const rect = element.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      setGraphSize((current) => (
        current.width === width && current.height === height ? current : { width, height }
      ))
    }

    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(element)
    window.addEventListener('resize', syncSize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncSize)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadGraph(false)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [loadGraph])

  useEffect(() => {
    if (!pathSource || !pathTarget) return
    window.electronAPI.relationshipGraph.getPath(pathSource.id, pathTarget.id, options)
      .then(setPathResult)
      .catch((e) => setPathResult({ success: false, error: e instanceof Error ? e.message : String(e) }))
  }, [options, pathSource, pathTarget])

  const nodeMap = useMemo(() => new Map((result?.nodes || []).map(node => [node.id, node])), [result?.nodes])
  const pathLinkKeys = useMemo(() => {
    const set = new Set<string>()
    for (const link of pathResult?.links || []) {
      const a = String(link.source)
      const b = String(link.target)
      set.add(a < b ? `${a}::${b}` : `${b}::${a}`)
    }
    return set
  }, [pathResult?.links])
  const selectedLinkKey = useMemo(() => selectedLink ? linkPairKey(selectedLink as unknown as GraphLinkObject) : '', [selectedLink])

  const visibleGraph = useMemo(() => {
    const nodes = result?.nodes || []
    let links = result?.links || []
    const cap = query.trim() || pathResult?.success ? MAX_SEARCH_LINKS : MAX_VISIBLE_LINKS
    if (links.length > cap) {
      links = [...links].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0)).slice(0, cap)
    }
    links = links.map(link => ({
      ...link,
      source: endpointId(link.source as string | GraphNodeObject),
      target: endpointId(link.target as string | GraphNodeObject),
      evidenceSessionIds: [...(link.evidenceSessionIds || [])],
    }))
    const visibleNodeIds = new Set<string>()
    for (const link of links) {
      visibleNodeIds.add(String(link.source))
      visibleNodeIds.add(String(link.target))
    }
    if (includeIsolated) {
      for (const node of nodes) visibleNodeIds.add(node.id)
    }
    return {
      nodes: nodes.filter(node => visibleNodeIds.has(node.id)),
      links,
    }
  }, [includeIsolated, pathResult?.success, query, result?.links, result?.nodes])
  const graphBusy = loading || previewing
  const graphBusyMessage = progress?.message || (previewing ? '正在后台更新关系网络' : '正在加载关系网络')
  const renderNote = previewing && visibleGraph.nodes.length > 0
    ? '预览中，群聊关系仍在补充'
    : result?.links && result.links.length > visibleGraph.links.length
      ? `已渲染最强 ${formatCount(visibleGraph.links.length)} / ${formatCount(result.links.length)} 条关系`
      : ''

  useEffect(() => {
    if (visibleGraph.nodes.length === 0) return
    const timers = [
      window.setTimeout(() => graphRef.current?.zoomToFit?.(650, 72), 450),
      window.setTimeout(() => graphRef.current?.zoomToFit?.(650, 72), 1400),
    ]
    return () => timers.forEach(window.clearTimeout)
  }, [graphSize.height, graphSize.width, visibleGraph.links.length, visibleGraph.nodes.length])

  const handleToggleRelation = (type: RelationshipGraphRelationType) => {
    setRelationTypes((current) => {
      if (current.includes(type)) {
        const next = current.filter(item => item !== type)
        return next.length > 0 ? next : current
      }
      return [...current, type]
    })
  }

  const handleNodeClick = (node: GraphNodeObject) => {
    const source = nodeMap.get(node.id)
    if (!source) return
    setSelectedNode(source)
    setSelectedLink(null)
    setAnalysisOpen(false)
    const distance = 90
    const distRatio = 1 + distance / Math.hypot(node.x || 0, node.y || 0, node.z || 0)
    graphRef.current?.cameraPosition(
      { x: (node.x || 0) * distRatio, y: (node.y || 0) * distRatio, z: (node.z || 0) * distRatio },
      node,
      900
    )
  }

  const handleLinkClick = (link: GraphLinkObject) => {
    setSelectedLink({
      ...link,
      source: endpointId(link.source),
      target: endpointId(link.target),
      evidenceSessionIds: [...(link.evidenceSessionIds || [])],
    })
    setSelectedNode(null)
    setAnalysisOpen(false)
  }

  const selectedSimilar = selectedNode ? result?.similar?.[selectedNode.id] || [] : []
  const inspectorOpen = Boolean(selectedNode || selectedLink || analysisOpen)

  const ensureFlowParticleStore = useCallback((): FlowParticleStore => {
    if (!flowParticlesRef.current) {
      flowParticlesRef.current = {
        group: new THREE.Group(),
        items: new Map(),
      }
    }

    const store = flowParticlesRef.current
    const scene = graphRef.current?.scene?.()
    if (scene && !store.group.parent) scene.add(store.group)
    return store
  }, [])

  const updateFlowParticles = useCallback(() => {
    const store = ensureFlowParticleStore()
    const wanted = new Set<string>()

    for (const link of visibleGraph.links as GraphLinkObject[]) {
      const pairKey = linkPairKey(link)
      const highlighted = pathLinkKeys.has(pairKey)
      const selected = selectedLinkKey === pairKey
      if (!highlighted && !selected) continue

      const count = highlighted ? 3 : 2
      const speed = (link.type === 'group_interaction' ? 0.0048 : 0.0032) * (highlighted ? 1.08 : 1)

      for (let i = 0; i < count; i += 1) {
        const itemKey = `${pairKey}:${i}`
        wanted.add(itemKey)
        let item = store.items.get(itemKey)

        if (item && (item.highlighted !== highlighted || item.selected !== selected)) {
          store.group.remove(item.object)
          store.items.delete(itemKey)
          item = undefined
        }

        if (!item) {
          item = {
            object: makeLinkParticle(link, highlighted, selected),
            link,
            progress: i / count,
            speed,
            highlighted,
            selected,
          }
          store.items.set(itemKey, item)
          store.group.add(item.object)
        } else {
          item.link = link
          item.speed = speed
        }

        const curve = linkCurveFromNodes(link, highlighted, selected)
        if (!curve) {
          item.object.visible = false
          continue
        }

        item.progress = (item.progress + item.speed) % 1
        item.object.visible = true
        item.object.position.copy(curve.getPoint(item.progress))
      }
    }

    for (const [itemKey, item] of store.items) {
      if (wanted.has(itemKey)) continue
      store.group.remove(item.object)
      store.items.delete(itemKey)
    }
  }, [ensureFlowParticleStore, pathLinkKeys, selectedLinkKey, visibleGraph.links])

  useEffect(() => {
    return () => {
      const store = flowParticlesRef.current
      if (!store) return
      store.group.parent?.remove(store.group)
      store.items.clear()
      flowParticlesRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const element = toolbarRef.current
    if (!element) return

    const updateGlass = () => {
      const rect = element.getBoundingClientRect()
      const map = createLiquidGlassMap(Math.round(rect.width), Math.round(rect.height), TOOLBAR_GLASS_SHAPE)
      if (map) setToolbarGlassMap(map)
    }

    updateGlass()
    const observer = new ResizeObserver(updateGlass)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const toolbarGlassStyle = toolbarGlassMap
    ? {
        backdropFilter: `url(#${toolbarGlassId}) blur(3px) brightness(1.08) saturate(1.08)`,
        WebkitBackdropFilter: `url(#${toolbarGlassId}) blur(3px) brightness(1.08) saturate(1.08)`,
      }
    : undefined

  return (
    <div className="relationship-page">
      <div className="relationship-toolbar" ref={toolbarRef} style={toolbarGlassStyle}>
        {toolbarGlassMap && (
          <svg className="relationship-toolbar-glass-defs" aria-hidden="true" focusable="false">
            <filter
              id={toolbarGlassId}
              colorInterpolationFilters="sRGB"
              filterUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={toolbarGlassMap.width}
              height={toolbarGlassMap.height}
            >
              <feImage href={toolbarGlassMap.href} xlinkHref={toolbarGlassMap.href} width={toolbarGlassMap.width} height={toolbarGlassMap.height} result="displacementMap" />
              <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={toolbarGlassMap.scale} xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </svg>
        )}
        <div className="relationship-title">
          <NodesRight width={24} height={24} />
          <div>
            <h1>关系网络</h1>
            <p>{result?.stats ? `${formatCount(result.stats.nodeCount)} 人 · ${formatCount(result.stats.linkCount)} 条关系` : '3D 力导向关系图谱'}</p>
          </div>
        </div>
        <div className="relationship-toolbar-controls">
          <SearchField
            aria-label="搜索联系人"
            className="relationship-search"
            name="relationship-search"
            value={query}
            variant="secondary"
            onChange={setQuery}
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="搜索联系人" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <div className="relationship-filter-row">
            {(Object.keys(RELATION_LABELS) as RelationshipGraphRelationType[]).map(type => (
              <Button
                key={type}
                size="sm"
                variant={relationTypes.includes(type) ? 'primary' : 'outline'}
                onPress={() => handleToggleRelation(type)}
              >
                {RELATION_LABELS[type]}
              </Button>
            ))}
            <Popover isOpen={filtersOpen} onOpenChange={setFiltersOpen}>
              <Button
                size="sm"
                variant={filtersOpen ? 'primary' : 'secondary'}
              >
                <Sliders width={16} height={16} />
                筛选
              </Button>
              <Popover.Content placement="bottom end" offset={8}>
                <Popover.Dialog className="relationship-filter-advanced">
                  <Slider
                    aria-label="最小权重"
                    className="relationship-field"
                    value={minWeight}
                    minValue={0}
                    maxValue={20}
                    step={1}
                    onChange={(value) => setMinWeight(toSliderNumber(value))}
                  >
                    <Label>最小权重</Label>
                    <Slider.Output>{minWeight}</Slider.Output>
                    <Slider.Track>
                      <Slider.Fill />
                      <Slider.Thumb />
                    </Slider.Track>
                  </Slider>
                  <div className="relationship-date-range">
                    <Label>时间范围</Label>
                    <DateRangePicker
                      startDate={startDate}
                      endDate={endDate}
                      onStartDateChange={setStartDate}
                      onEndDateChange={setEndDate}
                    />
                  </div>
                  <div className="relationship-switch">
                    <span>显示孤岛</span>
                    <Switch aria-label="显示孤岛" isSelected={includeIsolated} onChange={setIncludeIsolated}>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch>
                  </div>
                </Popover.Dialog>
              </Popover.Content>
            </Popover>
          </div>
          <div className="relationship-actions">
            <Button variant={analysisOpen ? 'primary' : 'secondary'} size="sm" onPress={() => {
              setSelectedNode(null)
              setSelectedLink(null)
              setAnalysisOpen(true)
            }}>
              <ChartBar width={16} height={16} />
              分析
            </Button>
            <Button variant="secondary" size="sm" onPress={() => graphRef.current?.zoomToFit?.(700, 80)}>适配视图</Button>
            <Button variant="primary" size="sm" onPress={() => void loadGraph(true)} isDisabled={graphBusy}>
              <ArrowsRotateLeft width={16} height={16} />
              重建
            </Button>
          </div>
        </div>
      </div>

      <main className="relationship-graph" ref={graphContainerRef}>
        {error ? (
          <div className="relationship-empty">
            <NodesRight width={42} height={42} />
            <h2>关系网络不可用</h2>
            <p>{error}</p>
          </div>
        ) : visibleGraph.nodes.length === 0 && !graphBusy ? (
          <div className="relationship-empty">
            <Magnifier width={42} height={42} />
            <h2>没有匹配的关系</h2>
          </div>
        ) : (
          <ForceGraph3D
            ref={graphRef}
            graphData={visibleGraph}
            width={graphSize.width}
            height={graphSize.height}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            nodeThreeObject={(node: GraphNodeObject) => makeNodeSprite(node)}
            nodeLabel={(node: GraphNodeObject) => `${node.label}<br/>权重 ${node.weightedDegree.toFixed(1)} · ${node.degree} 条关系`}
            nodeRelSize={5}
            linkColor={(link: GraphLinkObject) => {
              const key = linkPairKey(link)
              if (pathLinkKeys.has(key)) return '#ffffff'
              if (selectedLinkKey === key) return '#ffffff'
              return RELATION_COLORS[link.type] || '#94a3b8'
            }}
            linkOpacity={1}
            linkResolution={8}
            linkThreeObject={(link: GraphLinkObject) => makeLinkLine(link)}
            linkPositionUpdate={(object: THREE.Object3D, coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }, rawLink: unknown) => {
              const link = rawLink as GraphLinkObject
              const key = linkPairKey(link)
              return updateLinkLinePosition(object, coords, link, pathLinkKeys.has(key), selectedLinkKey === key)
            }}
            linkDirectionalParticles={0}
            onEngineTick={updateFlowParticles}
            onNodeClick={handleNodeClick}
            onLinkClick={handleLinkClick}
          />
        )}

        {graphBusy && (
          <div className="relationship-loading">
            <Spinner size="sm" />
            <span>{graphBusyMessage}</span>
          </div>
        )}
        {renderNote && (
          <div className="relationship-render-note">
            {renderNote}
          </div>
        )}
      </main>

      <Drawer.Backdrop
        className="relationship-inspector-backdrop"
        isOpen={inspectorOpen}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedNode(null)
            setSelectedLink(null)
            setAnalysisOpen(false)
          }
        }}
        variant="transparent"
      >
        <Drawer.Content className="relationship-inspector-content" placement="right">
          <Drawer.Dialog className="relationship-inspector" aria-label="关系网络详情">
            <Drawer.CloseTrigger />
            <Drawer.Body>
              <ScrollShadow className="relationship-inspector-scroll">
          {selectedNode ? (
            <section>
              <div className="relationship-person-head">
                <Avatar size="lg">
                  {selectedNode.avatarUrl ? <Avatar.Image src={selectedNode.avatarUrl} alt={selectedNode.label} /> : null}
                  <Avatar.Fallback><Person width={22} height={22} /></Avatar.Fallback>
                </Avatar>
                <div>
                  <h2>{selectedNode.label}</h2>
                  <p>{selectedNode.id}</p>
                </div>
              </div>
              <div className="relationship-metric-grid">
                <div><strong>{selectedNode.degree}</strong><span>关系数</span></div>
                <div><strong>{selectedNode.weightedDegree.toFixed(1)}</strong><span>中心性</span></div>
                <div><strong>{selectedNode.communityId || '-'}</strong><span>社群</span></div>
                <div><strong>{formatTime(selectedNode.lastActiveTime)}</strong><span>最近活跃</span></div>
              </div>
              <div className="relationship-path-actions">
                <Button size="sm" variant="secondary" onPress={() => setPathSource(selectedNode)}>设为起点</Button>
                <Button size="sm" variant="secondary" onPress={() => setPathTarget(selectedNode)}>设为终点</Button>
              </div>
              {selectedSimilar.length > 0 && (
                <div className="relationship-section">
                  <h3>相似联系人</h3>
                  {selectedSimilar.map(node => (
                    <Button key={node.id} className="relationship-list-item" variant="ghost" onPress={() => setSelectedNode(node)}>
                      <span>{node.label}</span>
                      <small>{node.weightedDegree.toFixed(1)}</small>
                    </Button>
                  ))}
                </div>
              )}
            </section>
          ) : selectedLink ? (
            <section>
              <h2>关系详情</h2>
              <div className="relationship-link-title">
                <Chip size="sm" variant="secondary">{RELATION_LABELS[selectedLink.type]}</Chip>
                <strong>{selectedLink.weight.toFixed(1)}</strong>
              </div>
              <p>{nodeMap.get(String(selectedLink.source))?.label || String(selectedLink.source)}</p>
              <p>{nodeMap.get(String(selectedLink.target))?.label || String(selectedLink.target)}</p>
              <div className="relationship-metric-grid">
                <div><strong>{formatCount(selectedLink.messageCount)}</strong><span>消息/互动</span></div>
                <div><strong>{formatCount(selectedLink.sharedGroupCount)}</strong><span>共同群</span></div>
                <div><strong>{formatTime(selectedLink.lastActiveTime)}</strong><span>最近证据</span></div>
              </div>
              <div className="relationship-section">
                <h3>证据会话</h3>
                {(selectedLink.evidenceSessionIds || []).slice(0, 12).map(id => <Chip key={id} size="sm" variant="soft">{id}</Chip>)}
              </div>
            </section>
          ) : (
            <section>
              <h2>图谱分析</h2>
              <div className="relationship-metric-grid">
                <div><strong>{formatCount(result?.stats?.communityCount)}</strong><span>社群</span></div>
                <div><strong>{formatCount(result?.stats?.isolatedCount)}</strong><span>孤岛</span></div>
                <div><strong>{formatCount(result?.stats?.directChatCount)}</strong><span>私聊边</span></div>
                <div><strong>{formatCount(result?.stats?.groupInteractionCount)}</strong><span>互动边</span></div>
              </div>
              <div className="relationship-section">
                <h3>中心人物</h3>
                {(result?.rankings?.central || []).slice(0, 10).map(node => (
                  <Button key={node.id} className="relationship-list-item" variant="ghost" onPress={() => setSelectedNode(node)}>
                    <span>{node.label}</span>
                    <small>{node.weightedDegree.toFixed(1)}</small>
                  </Button>
                ))}
              </div>
              <div className="relationship-section">
                <h3>社群</h3>
                {(result?.communities || []).slice(0, 10).map(item => (
                  <div key={item.id} className="relationship-list-item relationship-list-item--static">
                    <span>{item.label}</span>
                    <small>{item.size} 人</small>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="relationship-section">
            <h3>路径分析</h3>
            <div className="relationship-path-box">
              <span>{pathSource?.label || '起点'}</span>
              <Link width={16} height={16} />
              <span>{pathTarget?.label || '终点'}</span>
            </div>
            {pathResult?.success ? (
              <div className="relationship-path-result">
                {(pathResult.nodeIds || []).map(id => nodeMap.get(id)?.label || id).join(' → ')}
              </div>
            ) : pathResult?.error ? (
              <p className="relationship-path-error">{pathResult.error}</p>
            ) : null}
          </section>
              </ScrollShadow>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </div>
  )
}

export default RelationshipGraphPage
