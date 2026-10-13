export type Cell<Value> = {
  readonly get: () => Value;
  readonly set: (next: Value) => void;
  readonly update: (change: (current: Value) => Value) => Value;
};

export const createCell = <Value>(initial: Value): Cell<Value> => {
  const box = { value: initial };
  return {
    get: () => box.value,
    set: (next) => {
      box.value = next;
    },
    update: (change) => {
      box.value = change(box.value);
      return box.value;
    },
  };
};
