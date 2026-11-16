# NOTICE

This entry is an original implementation written for the make.fun
markdown-render-speed-02 competition. It was developed against marked
18.1.3 as the reference renderer: the task requires byte-identical HTML
output, so the block and inline grammar patterns in `parse.js` were
generated from marked's published grammar, and the rendering semantics
were verified case by case against marked's output on the practice set.

marked is copyright (c) 2011-2024, Christopher Jeffrey and contributors,
and is distributed under the MIT License (see LICENSE for this entry's
own MIT license text). The marked source itself is not included in this
repository and no marked code is copied here; the implementation,
structure, and rendering engine are original.

Reference: marked 18.1.3, https://github.com/markedjs/marked (MIT).
