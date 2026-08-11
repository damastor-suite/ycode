import { getDb } from '../lib/platform/db';
import type { Layer } from '../types';

const pageId = 'e9c9a71d-ff08-4eb5-84af-94bd21c9b046';

async function checkLayerVariables() {
  const db = await getDb();

  // Get draft layers
  const data = await db('page_layers')
    .select('*')
    .where('page_id', pageId)
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .limit(1)
    .first();

  if (!data || !data.layers) {
    console.log('No layers found');
    process.exit(0);
  }

  // Recursively find all text and heading layers with variables.text
  interface TextLayerResult {
    id: string;
    name: string;
    customName: string;
    path: string;
    variableType: string;
    data: unknown;
  }

  function findTextLayers(layers: Layer[], path = ''): TextLayerResult[] {
    const results: TextLayerResult[] = [];
    
    for (const layer of layers) {
      const currentPath = path ? `${path} > ${layer.name}` : layer.name;
      
      if (['text', 'heading'].includes(layer.name) && layer.variables?.text) {
        results.push({
          id: layer.id,
          name: layer.name,
          customName: layer.customName || layer.name,
          path: currentPath,
          variableType: layer.variables.text.type,
          data: layer.variables.text.data
        });
      }
      
      if (layer.children && layer.children.length > 0) {
        results.push(...findTextLayers(layer.children, currentPath));
      }
    }
    
    return results;
  }

  const textLayers = findTextLayers(data.layers);
  
  console.log(`Found ${textLayers.length} text/heading layers with variables.text:`);
  console.log('');
  
  for (const layer of textLayers) {
    console.log('Layer:', layer.customName);
    console.log('  Path:', layer.path);
    console.log('  Type:', layer.variableType);
    console.log('  Data:', JSON.stringify(layer.data, null, 2));
    console.log('');
  }

  process.exit(0);
}

checkLayerVariables();
