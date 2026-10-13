/**
 * CSS loader for Node.js test environment
 * Handles .css?raw imports by returning the file content as a string
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  // Handle .css?raw imports
  if (url.endsWith('.css?raw')) {
    const filePath = fileURLToPath(url.replace('?raw', ''));
    const content = readFileSync(filePath, 'utf-8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(content)};`,
      shortCircuit: true,
    };
  }

  // Pass through to the next loader
  return nextLoad(url, context);
}
