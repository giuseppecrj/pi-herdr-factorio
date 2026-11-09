import type { Server } from "node:http";

export function closeHttpServer(server: Server): Promise<void> {
	return new Promise((done) => server.close(() => done()));
}
