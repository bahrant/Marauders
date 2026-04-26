import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Global mocks for SCADA/JointJS environment - more complete to avoid runtime errors in scada-init.ts
vi.mock('@joint/plus', () => {
  const mockDia = {
    Graph: vi.fn(() => ({
      on: vi.fn(),
      getElements: vi.fn(() => []),
      addCells: vi.fn(),
    })),
    Paper: vi.fn(() => ({
      el: document.createElement('div'),
      model: { on: vi.fn() },
      transformToFitContent: vi.fn(),
      unfreeze: vi.fn(),
      remove: vi.fn(),
      findView: vi.fn().mockReturnValue({}),
    })),
    Element: vi.fn().mockImplementation(() => ({})),
    Link: vi.fn().mockImplementation(() => ({})),
    ElementView: {
      extend: vi.fn().mockImplementation((obj) => ({ ...obj, prototype: {} })),
      addPresentationAttributes: vi.fn((attrs) => attrs),
      Flags: { RENDER: 1 },
    },
    LinkView: {
      extend: vi.fn().mockImplementation((obj) => ({ ...obj, prototype: {} })),
      addPresentationAttributes: vi.fn((attrs) => attrs),
      prototype: { initFlag: [] },
    },
    HighlighterView: {
      extend: vi.fn().mockImplementation((obj) => ({ ...obj, add: vi.fn() })),
    },
  };
  return {
    dia: mockDia,
    shapes: {},
    util: { svg: vi.fn(() => '') },
    g: { random: vi.fn(() => 5) },
  };
});

// Mock window APIs used in scada-init.ts
(global as any).setInterval = vi.fn(() => 123);
(global as any).clearInterval = vi.fn();
