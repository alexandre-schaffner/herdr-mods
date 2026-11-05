// PDF pages for the viewer, through PDFKit.
//   pdf info <file>                          → {"pages": n, "width": pt, "height": pt}  (first page)
//   pdf render <file> <page> <width> <out>   → writes page (1-based) as PNG, `width` px wide
import AppKit
import PDFKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else { fail("cannot open PDF") }
if doc.isLocked { fail("this PDF is password protected") }

switch args[1] {
case "info":
    let box = doc.page(at: 0)?.bounds(for: .cropBox) ?? .zero
    print("{\"pages\":\(doc.pageCount),\"width\":\(Int(box.width)),\"height\":\(Int(box.height))}")
case "render":
    guard args.count == 6, let index = Int(args[3]), let width = Double(args[4]),
          let page = doc.page(at: index - 1) else { fail("usage: pdf render <file> <page> <width> <out>") }
    let box = page.bounds(for: .cropBox)
    let rotated = page.rotation % 180 != 0
    let size = rotated ? CGSize(width: box.height, height: box.width) : box.size
    let scale = width / size.width
    let px = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    guard let ctx = CGContext(data: nil, width: Int(px.width), height: Int(px.height), bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { fail("cannot allocate the page") }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(origin: .zero, size: px))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .cropBox, to: ctx)
    guard let image = ctx.makeImage(),
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    else { fail("cannot encode the page") }
    do { try png.write(to: URL(fileURLWithPath: args[5]), options: .atomic) } catch { fail("cannot write \(args[5])") }
default:
    fail("unknown command \(args[1])")
}
