import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { SerializerState, type RemarkParser } from "@milkdown/kit/transformer";

interface BlockGroup {
  nodes: ProseNode[];
}

interface CachedGroup {
  members: ProseNode[];
  markdown: string;
}

function isList(node: ProseNode): boolean {
  return node.type.name === "bullet_list" || node.type.name === "ordered_list";
}

function sameMembers(left: ProseNode[], right: ProseNode[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function trimBoundaryNewlines(value: string): string {
  return value.replace(/^\n+|\n+$/g, "");
}

function buildGroups(doc: ProseNode): BlockGroup[] {
  let count = doc.childCount;
  const last = count ? doc.child(count - 1) : null;
  if (last?.type.name === "paragraph" && last.content.size === 0) count -= 1;
  const groups: BlockGroup[] = [];
  for (let index = 0; index < count;) {
    const first = doc.child(index);
    if (!isList(first)) {
      groups.push({ nodes: [first] });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < count && isList(doc.child(end))) end += 1;
    groups.push({ nodes: Array.from({ length: end - index }, (_, offset) => doc.child(index + offset)) });
    index = end;
  }
  return groups;
}

export interface MarkdownSnapshotCache {
  serialize: (schema: Schema, remark: RemarkParser, doc: ProseNode) => string;
  prewarm: (schema: Schema, remark: RemarkParser, doc: ProseNode, budgetMs?: number) => boolean;
}

export function createMarkdownSnapshotCache(): MarkdownSnapshotCache {
  const blocks = new WeakMap<ProseNode, string>();
  const listGroups = new WeakMap<ProseNode, CachedGroup>();
  let document: ProseNode | null = null;
  let groups: BlockGroup[] = [];
  let cursor = 0;

  const groupsFor = (doc: ProseNode): BlockGroup[] => {
    if (document === doc) return groups;
    document = doc;
    groups = buildGroups(doc);
    cursor = 0;
    return groups;
  };

  const serializeGroup = (schema: Schema, remark: RemarkParser, group: BlockGroup): string => {
    const first = group.nodes[0];
    if (group.nodes.length === 1) {
      const cached = blocks.get(first);
      if (cached !== undefined) return cached;
      const markdown = trimBoundaryNewlines(SerializerState.create(schema, remark)(schema.nodes.doc.create(null, first)));
      blocks.set(first, markdown);
      return markdown;
    }
    const cached = listGroups.get(first);
    if (cached && sameMembers(cached.members, group.nodes)) return cached.markdown;
    const markdown = trimBoundaryNewlines(SerializerState.create(schema, remark)(schema.nodes.doc.create(null, group.nodes)));
    listGroups.set(first, { members: group.nodes, markdown });
    return markdown;
  };

  const serialize = (schema: Schema, remark: RemarkParser, doc: ProseNode): string => {
    const parts = groupsFor(doc).map((group) => serializeGroup(schema, remark, group));
    const joined = parts.join("\n\n");
    return joined && !joined.endsWith("\n") ? joined + "\n" : joined;
  };

  const prewarm = (schema: Schema, remark: RemarkParser, doc: ProseNode, budgetMs = 4): boolean => {
    const pending = groupsFor(doc);
    const deadline = performance.now() + Math.max(1, budgetMs);
    while (cursor < pending.length && performance.now() < deadline) {
      serializeGroup(schema, remark, pending[cursor]);
      cursor += 1;
    }
    return cursor >= pending.length;
  };

  return { serialize, prewarm };
}
