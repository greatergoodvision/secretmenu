import fs from 'node:fs/promises';

const file = 'public/catalog.json';
const catalog = JSON.parse(await fs.readFile(file, 'utf8'));
const before = Array.isArray(catalog.products) ? catalog.products.length : 0;

const products = [];
for (const product of catalog.products || []) {
  const media = [];
  const seen = new Set();

  for (const item of Array.isArray(product.media) ? product.media : []) {
    const src = String(item?.src || '').trim();
    if (!src || /attachment_thumbnails\/video_dark\.png/i.test(src)) continue;
    const type = item?.type === 'video' ? 'video' : 'image';
    const key = `${type}:${src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    media.push({ ...item, type, src });
  }

  const image = String(product.image || '').trim();
  if (image && !/attachment_thumbnails\/video_dark\.png/i.test(image) && !seen.has(`image:${image}`)) {
    media.unshift({ type: 'image', src: image });
  }

  if (!media.length) continue;

  const firstImage = media.find(m => m.type === 'image')?.src || null;
  products.push({ ...product, image: firstImage, media });
}

catalog.products = products;
catalog.count = products.length;
catalog.imageCount = products.reduce((n, p) => n + p.media.filter(m => m.type === 'image').length, 0);
catalog.videoCount = products.reduce((n, p) => n + p.media.filter(m => m.type === 'video').length, 0);
catalog.mediaCount = catalog.imageCount + catalog.videoCount;
catalog.fullMediaProducts = products.filter(p => p.media.filter(m => m.type === 'image').length >= 2 && p.media.some(m => m.type === 'video')).length;
catalog.filteredToMediaOnly = true;
catalog.updatedAt = new Date().toISOString();

await fs.writeFile(file, JSON.stringify(catalog, null, 2));
console.log(`Filtered menu from ${before} to ${products.length} strains with media.`);
