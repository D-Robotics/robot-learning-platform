import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import MarkdownIt from 'markdown-it';

const REPOSITORY_DOCS = 'https://github.com/D-Robotics/robot-learning-platform/blob/main/docs/';
const IMAGE_PREFIX = 'assets/user-guide/';
const ORIGINMAN_COURSE_GUIDE =
  '../plugins/rdk-robot-learning-platform/references/user-guide.md#workshop受扰恢复课程';

export function createUsageManualRouter(
  docsRoot: string,
  publicPath: (pathname: string) => string,
) {
  const router = express.Router();
  const markdown = new MarkdownIt({ html: false });
  const renderImage = markdown.renderer.rules.image;

  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const image = tokens[index];
    const source = String(image.attrGet('src') ?? '');
    if (source.startsWith(IMAGE_PREFIX)) {
      image.attrSet(
        'src',
        publicPath('/help/user-guide-images/' + source.slice(IMAGE_PREFIX.length)),
      );
    }
    image.attrSet('loading', 'lazy');
    return renderImage?.(tokens, index, options, env, renderer) ?? '';
  };
  markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    const link = tokens[index];
    const href = String(link.attrGet('href') ?? '');
    if (href === markdown.normalizeLink(ORIGINMAN_COURSE_GUIDE)) {
      link.attrSet('data-originman-course-guide', '');
      link.attrSet('aria-haspopup', 'dialog');
    }
    if (href && !href.startsWith('#')) {
      link.attrSet('href', new URL(href, REPOSITORY_DOCS).href);
      link.attrSet('target', '_blank');
      link.attrSet('rel', 'noopener noreferrer');
    }
    return renderer.renderToken(tokens, index, options);
  };

  router.use('/user-guide-images', express.static(path.join(docsRoot, IMAGE_PREFIX)));
  router.get('/user-guide.json', async (_request, response) => {
    response.set('Cache-Control', 'no-cache');
    try {
      const source = await readFile(path.join(docsRoot, 'user-guide.md'), 'utf8');
      // The panel header provides the document title in the workbench.
      response.json({ html: markdown.render(source.replace(/^# [^\n]+\r?\n/, '')) });
    } catch {
      response.status(503).json({ error: 'SIM2REAL_USAGE_MANUAL_UNAVAILABLE' });
    }
  });
  return router;
}
