// Waits for something whose failure changes nothing, such as tidying a page that may have closed, and gives back
// what it gave, or nothing.
export const quietly = async <Value>(promise: Promise<Value>): Promise<Value | undefined> => {
  try {
    return await promise;
  } catch {
    return undefined;
  }
};
