const { createFileNodeFromBuffer } = require('gatsby-source-filesystem');

exports.sourceNodes = async ({
  actions,
  cache,
  createNodeId,
  getNode,
  getNodesByType,
  store,
  reporter,
}) => {
  // This `require` has to be here instead of outside this fn - it blows up the `sharp` install for some reason if not done this way
  const { pdfToPng } = require('pdf-to-png-converter');
  const { createNode, createNodeField, touchNode } = actions;

  const allPdfNodes = getNodesByType(`ContentfulAsset`).filter(
    (node) => node.file?.contentType === 'application/pdf'
  );

  if (!allPdfNodes || allPdfNodes.length === 0) {
    console.info('No PDF assets founds, skipping thumbnail generation.');
    return;
  }

  // Create a progress bar
  const bar = reporter.createProgress(
    `Generating PDF thumbnails`,
    allPdfNodes.length
  );
  bar.start();

  for (let pdfNode of allPdfNodes) {
    const pdfName = pdfNode.file.fileName;
    const ID = `contentful-asset-${pdfNode.contentful_id}-${pdfNode.node_locale}-thumbnail`;

    // First try to see if the thumbnail has already been generated on this filesystem - check the cache for a matching ID
    // If it exists, then we'll use that as the source file
    let fileNodeID;
    const cachedThumbnail = await cache.get(ID);
    if (cachedThumbnail) {
      fileNodeID = cachedThumbnail.fileNodeID; // eslint-disable-line prefer-destructuring
      touchNode(getNode(cachedThumbnail.fileNodeID));
    }

    // If we don't have cached data then we need to generate a thumbnail to be used as the source file
    if (!fileNodeID) {
      // Get the absolute filepath for the version of the PDF file that we've downloaded locally
      let pdfPath;
      if (pdfNode?.fields?.localFile) {
        const localFileNode = await getNode(pdfNode.fields.localFile);
        if (localFileNode && localFileNode.absolutePath) {
          pdfPath = localFileNode.absolutePath;
        }
      }
      if (!pdfPath) {
        console.warn(`Failed to find local filepath for ${pdfName}, skipping`);
        continue;
      }

      const thumbnails = await pdfToPng(pdfPath, {
        useSystemFonts: false, // Fallback to use system fonts if not embedded in doc
        viewportScale: 0.33, // Create a small thumbnail,
        pages: [1],
      });

      const fileNode = await createFileNodeFromBuffer({
        buffer: thumbnails[0].content,
        name: `${pdfName.replaceAll('.', '_')}-thumbnail`,
        store,
        cache,
        createNode,
        createNodeId,
      });

      // Provided the thumbnail generated and saved we should add it to the cache so it can be reused in the future
      if (fileNode) {
        fileNodeID = fileNode.id;
        await cache.set(ID, { fileNodeID });
      }
    }

    // If we have a thumbnail at this point (either a previously-cached version or a newly-generated one) then add
    // it as a reference field to the Asset node. This is just an ID reference - the actual magic linkage is done by
    // the custom resolver defined below.
    if (fileNodeID) {
      createNodeField({ node: pdfNode, name: `thumbnail`, value: fileNodeID });
    } else {
      console.warn(`Failed to find/generate thumbnail for ${pdfName}`);
    }

    // Advance progress bar
    bar.tick();
  }
};

exports.createResolvers = ({ createResolvers }) => {
  const resolvers = {
    // Add the 'thumbnail' node we're appending to ContentfulAsset entries to the GraphQL schema via a custom `resolver`
    ContentfulAsset: {
      thumbnail: {
        type: `File`,
        resolve: async (source, args, context, info) => {
          return await context.nodeModel.getNodeById({
            id: source.fields.thumbnail,
          });
        },
      },
    },
  };
  createResolvers(resolvers);
};
