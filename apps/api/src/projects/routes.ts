import type { FastifyInstance } from 'fastify';
import type { ProjectRepository } from './repo.js';

export function registerProjectRoutes(app: FastifyInstance, projects: ProjectRepository): void {
  app.get('/api/projects', () => projects.list());
}
