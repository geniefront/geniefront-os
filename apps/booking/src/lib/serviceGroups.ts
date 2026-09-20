import type { Service } from "./api";
export interface ServiceGroup {
  key: string;
  name: string;
  services: Service[];
}
/** Merge only explicit duration variants with the same name and category. */
export function groupServices(services: Service[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const service of services) {
    const stripped = service.name
      .replace(
        /\s*[-–·(（]?\s*\d+\s*(?:min(?:ute)?s?|分钟|分鐘|분|phút|minutos)\s*[)）]?\s*$/iu,
        "",
      )
      .trim();
    const name = stripped || service.name,
      key = `${service.categoryId ?? ""}:${name}`;
    const group = groups.get(key) ?? { key, name, services: [] };
    group.services.push(service);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    services: g.services.sort((a, b) => a.durationMin - b.durationMin),
  }));
}
