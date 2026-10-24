import { mount } from '@vue/test-utils';
import { Event } from '@appland/models';
import DiagramSequence from '@/components/DiagramSequence.vue';
import CallLabel from '@/components/sequence/CallLabel.vue';
import SequenceDiagramPage from '@/pages/SequenceDiagram.vue';
import { buildStore, SET_APPMAP_DATA, SELECT_CODE_OBJECT } from '@/store/vsCode';

function diagram(eventIds = [41]) {
  return {
    actors: [{ id: 'worker', name: 'Worker', order: 0 }],
    rootActions: [
      {
        nodeType: 3,
        name: 'run',
        callee: 'worker',
        static: false,
        digest: 'run-digest',
        subtreeDigest: 'run-tree',
        stableProperties: {},
        eventIds,
        children: [],
      },
    ],
  };
}

const appMapData = {
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
          children: [{ name: 'run', type: 'function', static: false, location: 'worker.rb:1' }],
        },
      ],
    },
  ],
  events: [
    {
      id: 41,
      event: 'call',
      thread_id: 1,
      defined_class: 'Worker',
      method_id: 'run',
      path: 'worker.rb',
      lineno: 1,
      parameters: [{ name: 'input', class: 'String', value: 'hello' }],
    },
    {
      id: 42,
      event: 'return',
      thread_id: 1,
      parent_id: 41,
      return_value: { class: 'String', value: 'done' },
    },
  ],
};

describe('serialized sequence call selection', () => {
  let wrapper;
  let store;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  beforeEach(() => {
    jest.useFakeTimers();
    Element.prototype.scrollIntoView = jest.fn();
    store = buildStore();
  });
  afterEach(() => {
    if (wrapper) wrapper.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  function render(props = {}) {
    wrapper = mount(DiagramSequence, {
      store,
      propsData: {
        serializedDiagram: diagram(),
        interactive: false,
        serializedSelection: true,
        ...props,
      },
    });
    return wrapper;
  }

  it('Given serialized calls only, when their label is clicked, then the existing call is visibly selected without an Event', async () => {
    render();
    expect(wrapper.find('.call.selected').exists()).toBe(false);
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('41');
    expect(store.getters.selectedObject).toBeUndefined();
    expect(wrapper.find('.parameters').exists()).toBe(false);
  });

  it('clears selection when the capability is disabled, without reviving it when re-enabled', async () => {
    render();
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.find('.call.selected').exists()).toBe(true);
    await wrapper.setProps({ serializedSelection: false });
    expect(wrapper.find('.call.selected').exists()).toBe(false);
    await wrapper.setProps({ serializedSelection: true });
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it.each([
    { caller: 'a', callee: 'a', direction: 'self', span: '.self-call' },
    { caller: 'a', callee: 'b', direction: 'right', span: '.single-span' },
    { caller: 'a', callee: 'c', direction: 'right', span: '.label-span' },
    { caller: 'a', callee: 'd', direction: 'right', span: '.connecting-span' },
    { caller: 'b', callee: 'a', direction: 'left', span: '.single-span' },
    { caller: 'c', callee: 'a', direction: 'left', span: '.label-span' },
    { caller: 'd', callee: 'a', direction: 'left', span: '.connecting-span' },
  ])(
    'selects the label for every arrow layout: %j',
    async ({ caller, callee, direction, span }) => {
      const source = diagram();
      source.actors = ['a', 'b', 'c', 'd'].map((id, order) => ({ id, name: id, order }));
      Object.assign(source.rootActions[0], { caller, callee });
      // Keep every intermediate lane reachable; otherwise layout removes it and
      // the non-adjacent cases silently become single-span calls.
      source.actors.forEach((actor, index) =>
        source.rootActions.push({
          ...diagram([100 + index]).rootActions[0],
          callee: actor.id,
          digest: `visit-${actor.id}`,
        })
      );
      render({ serializedDiagram: source });
      const call = wrapper.findAll('.call').at(0);
      expect(call.find(span).exists()).toBe(true);
      await call.get('.event-name').trigger('click');
      expect(wrapper.get('.call.selected').classes()).toContain(`call-${direction}`);
    }
  );

  it('keeps selection identity through collapse and rerender, resetting on new input', async () => {
    const source = diagram();
    source.rootActions[0].children = [
      { ...diagram([73]).rootActions[0], name: 'child', digest: 'child-digest' },
    ];
    render({ serializedDiagram: source, interactive: true });
    await wrapper.findAll('.event-name').at(1).trigger('click');
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('73');
    await wrapper.get('.collapse-expand').trigger('click');
    expect(wrapper.get('.call.selected').classes()).toContain('call-collapsed');
    await wrapper.get('.collapse-expand').trigger('click');
    expect(wrapper.get('.call.selected').classes()).not.toContain('call-collapsed');
    wrapper.vm.$forceUpdate();
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('73');
    await wrapper.setProps({ serializedDiagram: diagram([73]) });
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it.each(
    [[], [undefined], ['41'], [-1], [NaN], [0], [1.5], [Number.MAX_SAFE_INTEGER + 1]].map(
      (ids) => ({ ids })
    )
  )('does not select calls with unusable IDs: %j', async ({ ids }) => {
    render({ serializedDiagram: diagram(ids) });
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it('rejects unknown IDs and layout-only clicks', async () => {
    render();
    for (const id of [999, undefined, '41', -1, NaN, 0, 1.5]) {
      wrapper.findComponent(CallLabel).vm.$emit('select-serialized-call', id);
      await wrapper.vm.$nextTick();
      expect(wrapper.find('.call.selected').exists()).toBe(false);
    }
  });

  it('does not reuse an unrelated AppMap selection in a serialized-only diagram', async () => {
    store.commit(SET_APPMAP_DATA, appMapData);
    store.commit(SELECT_CODE_OBJECT, store.state.appMap.eventsById[1]);
    render({ serializedDiagram: diagram([1]) });
    expect(wrapper.find('.call.selected').exists()).toBe(false);
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('1');
    await wrapper.setProps({ serializedDiagram: diagram([1]) });
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it('rejects ambiguous IDs and IDs belonging to another call', async () => {
    const source = diagram();
    source.rootActions.push({ ...diagram([73]).rootActions[0], name: 'other' });
    render({ serializedDiagram: source });
    wrapper.findComponent(CallLabel).vm.$emit('select-serialized-call', 73);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.call.selected').exists()).toBe(false);
    const ambiguous = diagram();
    ambiguous.rootActions.push({ ...diagram().rootActions[0], name: 'duplicate' });
    await wrapper.setProps({ serializedDiagram: ambiguous });
    await wrapper.findAll('.event-name').at(0).trigger('click');
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it('does not turn layout-only clicks into selection', async () => {
    render();
    await wrapper.get('.call-line-segment').trigger('click');
    expect(wrapper.find('.call.selected').exists()).toBe(false);
    wrapper.findComponent(CallLabel).vm.$emit('select-serialized-call', 999);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it('preserves read-only serialized consumers unless selection is explicitly enabled', async () => {
    wrapper = mount(SequenceDiagramPage, {
      store,
      propsData: { serializedDiagram: diagram(), interactive: false },
    });
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.find('.call.selected').exists()).toBe(false);
    await wrapper.setProps({ serializedSelection: true });
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('41');
  });

  it('keeps directly embedded serialized diagrams read-only by default', async () => {
    wrapper = mount(DiagramSequence, {
      store,
      propsData: { serializedDiagram: diagram(), interactive: false },
    });
    await wrapper.get('.event-name').trigger('click');
    expect(wrapper.find('.call.selected').exists()).toBe(false);
  });

  it('preserves authentic main AppMap Event selection, parameters and returns', async () => {
    store.commit(SET_APPMAP_DATA, appMapData);
    render({
      serializedDiagram: undefined,
      appMap: store.state.appMap,
      interactive: true,
      serializedSelection: false,
    });
    await wrapper.get('.event-name').trigger('click');
    expect(store.getters.selectedObject).toBeInstanceOf(Event);
    expect(store.getters.selectedObject).toBe(store.state.appMap.eventsById[1]);
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('1');
    expect(wrapper.get('.parameters').text()).toBe('input: hello');
    expect(wrapper.text()).toContain('done');
  });

  it('gives the authentic AppMap path precedence over serialized selection', async () => {
    store.commit(SET_APPMAP_DATA, appMapData);
    const source = diagram([1]);
    source.rootActions[0].returnValue = {
      returnValueType: { name: 'String' },
      raisesException: false,
    };
    render({ serializedDiagram: source, appMap: store.state.appMap, interactive: true });
    await wrapper.get('.event-name').trigger('click');
    expect(store.getters.selectedObject).toBeInstanceOf(Event);
    expect(store.getters.selectedObject).toBe(store.state.appMap.eventsById[1]);
    expect(wrapper.get('.call.selected').attributes('data-event-ids')).toBe('1');
    expect(wrapper.get('.parameters').text()).toBe('input: hello');
    expect(wrapper.text()).toContain('done');
  });
});
