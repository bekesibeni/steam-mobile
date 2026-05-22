export interface Page<T, C> {
  items: T[];
  next: C | undefined;
}

export async function paginate<T, C>(
  fetchPage: (cursor: C | undefined) => Promise<Page<T, C>>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: C | undefined;
  do {
    const { items, next } = await fetchPage(cursor);
    all.push(...items);
    cursor = next;
  } while (cursor !== undefined);
  return all;
}
