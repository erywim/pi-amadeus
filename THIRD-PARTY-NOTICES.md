# Third-party notices

The conversion feature adds the following independently sourced dependencies. Their licenses are not changed by the MIT license in the repository root. Before distributing a packaged application, regenerate the dependency inventory and include the complete license texts required by each package and its transitive/native assets.

- **officeparser 8.3.0** — MIT. It depends on `fflate`, `file-type`, `pdfjs-dist`, `tesseract.js`, and `@xmldom/xmldom`; audit and include their notices as well.
- **pdf-lib 1.17.1** — MIT.
- **sharp 0.35.5** — Apache-2.0. Its platform packages include libvips and other native libraries under their own licenses, including LGPL-3.0-or-later components. Preserve the package notices and satisfy any applicable source/notice obligations.
- **fflate 0.8.3** — MIT. It is used for local image archives and as an OfficeParser dependency.
- **yaml 2.9.1** — ISC. It is used for JSON/YAML conversion.

The implementation intentionally does not copy or redistribute FlyingMouse Format source, binaries, resources, or its custom non-commercial license. FFmpeg, Poppler, LibreOffice, Tesseract, and Pandoc remain optional system executables and are not bundled by this change. If they are bundled later, add their exact versions, build flags, source offers, notices, codec/patent review, and platform packaging records here.

This file is an engineering inventory, not legal advice. Re-run the package and native-library license audit for every release artifact.
