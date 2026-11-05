// Draw raw CMYK pixels (already converted with the printer's ICC profile) into a PDF page.
const { PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = require('pdf-lib');

let seq = 0;
function embedCmyk(doc, { w, h, bytes }) {
  const stream = doc.context.flateStream(bytes, {
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8,
  });
  return { ref: doc.context.register(stream), w, h };
}

// x, y, width, height in PDF points (bottom-left origin), like page.drawImage.
function drawCmyk(page, img, { x, y, width, height }) {
  const name = `ImCMYK${++seq}`;
  page.node.setXObject(PDFName.of(name), img.ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(width, 0, 0, height, x, y), drawObject(name), popGraphicsState());
}

module.exports = { embedCmyk, drawCmyk };
