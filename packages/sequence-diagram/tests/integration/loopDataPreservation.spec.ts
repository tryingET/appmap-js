import { buildAppMap } from '@appland/models';
import { LIST_USERS_APPMAP, LIST_USERS_PREFETCH_APPMAP, loadDiagram } from '../util';
import type { Action, Diagram } from '../../src/types';
import { isFunction, isLoop, NodeType } from '../../src/types';
import { format as json } from '../../src/formatter/json';

type Call = {
  name: string;
  result?: string;
  exception?: boolean;
  properties?: { name: string; class: string }[];
  elapsed?: number;
  children?: Call[];
};

function build(calls: Call[], loops = true): Diagram {
  const events: Record<string, unknown>[] = [];
  const names = new Set<string>();
  const append = (call: Call) => {
    names.add(call.name);
    const id = events.length + 1;
    events.push({
      id,
      event: 'call',
      thread_id: 1,
      defined_class: 'Worker',
      method_id: call.name,
      path: 'worker.rb',
      lineno: 1,
    });
    call.children?.forEach(append);
    events.push({
      id: events.length + 1,
      event: 'return',
      thread_id: 1,
      parent_id: id,
      elapsed: call.elapsed ?? 0.01,
      return_value: call.result ? { class: call.result, properties: call.properties } : undefined,
      exceptions: call.exception ? [{ class: 'Failure', message: 'failed' }] : undefined,
    });
  };
  append({ name: 'root', children: calls });
  const appmap = buildAppMap({
    version: '1.12',
    metadata: {},
    classMap: [
      {
        name: 'app',
        type: 'package',
        children: [
          {
            name: 'Worker',
            type: 'class',
            children: [...names].map((name) => ({
              name,
              type: 'function',
              static: false,
              location: 'worker.rb:1',
            })),
          },
        ],
      },
    ],
    events,
  }).build();
  return loadDiagram(appmap, { loops });
}

function metadataByEvent(diagram: Diagram): unknown[] {
  const entries: [number, unknown][] = [];
  const visit = (action: Action) => {
    action.eventIds.forEach((id) =>
      entries.push([
        id,
        isFunction(action)
          ? {
              name: action.name,
              caller: action.caller?.id,
              callee: action.callee.id,
              stableProperties: action.stableProperties,
              returnValue: action.returnValue,
            }
          : { nodeType: action.nodeType },
      ])
    );
    action.children.forEach(visit);
  };
  diagram.rootActions.forEach(visit);
  return entries.sort(([left], [right]) => left - right);
}

const repeated = (result = 'String'): Call => ({ name: 'a', result });

describe('GIVEN real AppMap events and enabled native loop compression', () => {
  it.each([
    { name: 'original list users', appmap: LIST_USERS_APPMAP },
    { name: 'original list users with prefetch', appmap: LIST_USERS_PREFETCH_APPMAP },
  ])(
    'WHEN $name is compressed THEN event metadata and elapsed sums agree with uncompressed native events',
    ({ appmap }) => {
      const original = loadDiagram(appmap, { loops: false });
      const compressed = loadDiagram(appmap);
      expect(metadataByEvent(compressed)).toEqual(metadataByEvent(original));
      const elapsed = new Map<number, number>();
      const collect = (action: Action) => {
        action.eventIds.forEach((id) => elapsed.set(id, action.elapsed || 0));
        action.children.forEach(collect);
      };
      original.rootActions.forEach(collect);
      const check = (action: Action) => {
        const expected = isLoop(action)
          ? action.children.reduce((sum, child) => sum + (child.elapsed || 0), 0)
          : action.eventIds.reduce((sum, id) => sum + elapsed.get(id)!, 0);
        expect(action.elapsed).toBeCloseTo(expected, 10);
        action.children.forEach(check);
      };
      compressed.rootActions.forEach(check);
      const innerCounts: number[] = [];
      const findInnerCounts = (action: Action) => {
        if (
          isLoop(action) &&
          action.children.some((child) => isFunction(child) && child.name === 'show')
        )
          innerCounts.push(action.count);
        action.children.forEach(findInnerCounts);
      };
      compressed.rootActions.forEach(findInnerCounts);
      expect(innerCounts).toEqual([2, 3, 2]);
    }
  );

  it('WHEN [a,b,a,b,c] is built THEN JSON retains c and every call event exactly once', () => {
    const calls = ['a', 'b', 'a', 'b', 'c'].map((name) => ({ name, result: 'String' }));
    const compressed = build(calls);
    expect(compressed.rootActions[0].children).toHaveLength(2);
    expect(compressed.rootActions[0].children[0]).toMatchObject({
      nodeType: NodeType.Loop,
      count: 2,
    });
    expect(compressed.rootActions[0].children[1]).toMatchObject({ name: 'c' });
    expect(metadataByEvent(compressed)).toEqual(metadataByEvent(build(calls, false)));
    expect(json(compressed)).toContain('"name": "c"');
  });

  it('WHEN two equivalent String returns repeat THEN compression and elapsed aggregation remain enabled', () => {
    const calls = [
      { ...repeated(), elapsed: 0.02 },
      { ...repeated(), elapsed: 0.03 },
    ];
    const children = build(calls).rootActions[0].children;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ nodeType: NodeType.Loop, count: 2 });
    expect(children[0].elapsed).toBeCloseTo(0.05);
    expect(children[0].children[0]).toMatchObject({
      eventIds: [2, 4],
      returnValue: { returnValueType: { name: 'string' }, raisesException: false },
    });
    expect(children[0].children[0].elapsed).toBeCloseTo(0.05);
  });

  it.each([
    { distinction: 'return type', other: repeated('Integer') },
    {
      distinction: 'return properties',
      other: { ...repeated(), properties: [{ name: 'size', class: 'Integer' }] },
    },
    { distinction: 'exception result', other: { name: 'a', exception: true } },
    { distinction: 'void result', other: { name: 'a' } },
  ])(
    'WHEN $distinction differs THEN both original return descriptions survive in native JSON',
    ({ other }) => {
      const calls = [repeated(), other];
      const compressed = build(calls);
      expect(compressed.rootActions[0].children).toHaveLength(2);
      expect(compressed.rootActions[0].children.some(isLoop)).toBe(false);
      expect(metadataByEvent(compressed)).toEqual(metadataByEvent(build(calls, false)));
      expect(json(compressed)).toBe(json(build(calls, false)));
    }
  );

  it('WHEN nested repeated windows have tails THEN all nested and tail return metadata survives', () => {
    const work = (): Call => ({
      name: 'work',
      result: 'String',
      children: ['a', 'b', 'a', 'b', 'c'].map((name) => ({ name, result: 'Integer' })),
    });
    const calls = [work(), work()];
    const compressed = build(calls);
    const outer = compressed.rootActions[0].children[0];
    expect(outer).toMatchObject({ nodeType: NodeType.Loop, count: 2 });
    expect(outer.children[0].children).toHaveLength(2);
    expect(outer.children[0].children[0]).toMatchObject({ nodeType: NodeType.Loop, count: 2 });
    expect(outer.children[0].children[1]).toMatchObject({ name: 'c' });
    expect(metadataByEvent(compressed)).toEqual(metadataByEvent(build(calls, false)));
  });

  it('WHEN otherwise identical parents have heterogeneous nested returns THEN the parent loop cannot erase them', () => {
    const calls = [
      { name: 'work', children: [repeated()] },
      { name: 'work', children: [repeated('Integer')] },
    ];
    const compressed = build(calls);
    expect(compressed.rootActions[0].children).toHaveLength(2);
    expect(metadataByEvent(compressed)).toEqual(metadataByEvent(build(calls, false)));
  });

  it('WHEN nested loops have different counts THEN outer compression preserves each count and event', () => {
    const calls = [
      { name: 'work', children: [repeated(), repeated()] },
      { name: 'work', children: [repeated(), repeated(), repeated()] },
    ];
    const compressed = build(calls);
    const children = compressed.rootActions[0].children;
    expect(children).toHaveLength(2);
    expect(children.map((action) => (action.children[0] as { count: number }).count)).toEqual([
      2, 3,
    ]);
    expect(metadataByEvent(compressed)).toEqual(metadataByEvent(build(calls, false)));
  });
});
