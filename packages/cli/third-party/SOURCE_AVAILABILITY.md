# EPL component source code availability

The components identified below are available in **source code form** under their
applicable Eclipse Public License, EPL-1.0 or EPL-2.0. Recipients can obtain the
source from the original contributors using the public HTTPS locations below:
open/download the source archive, or browse/clone the linked source repository.
The applicable full license texts and original copyright/contributor notices
are included in `THIRD_PARTY_NOTICES.txt` and the content-addressed `texts/` files.
This statement provides retrieval instructions; it does not change those licenses.

## ELK Java layout algorithms and elkjs wrapper — EPL-2.0

- The actual Eclipse Layout Kernel **Java source**, not merely the JavaScript
  wrapper/build scripts, is maintained by the Eclipse ELK contributors at
  https://github.com/eclipse-elk/elk . Obtain its source history with
  `git clone https://github.com/eclipse-elk/elk.git`, or use the source downloads
  listed at https://github.com/eclipse-elk/elk/tags .
- A known ELK source release is **v0.10.0**, commit
  `30035c605c0d45467f673f7b6b263d44dc2632da`:
  https://github.com/eclipse-elk/elk/tree/30035c605c0d45467f673f7b6b263d44dc2632da .
  Source archive:
  https://github.com/eclipse-elk/elk/archive/30035c605c0d45467f673f7b6b263d44dc2632da.tar.gz .
  This release is a retrieval reference, **not an assertion that it is the exact
  Java revision used in the historical elkjs 0.9.3 bundle**.
- The distributed wrapper/library is **elkjs 0.9.3**, unmodified in this build.
  Its publication-linked source commit is
  `a8304cf79fde75bc2ab1a89d28320f53f8637436`:
  https://github.com/kieler/elkjs/tree/a8304cf79fde75bc2ab1a89d28320f53f8637436 .
  Source archive:
  https://github.com/kieler/elkjs/archive/a8304cf79fde75bc2ab1a89d28320f53f8637436.tar.gz .
- Exact npm distribution identifier:
  https://registry.npmjs.org/elkjs/-/elkjs-0.9.3.tgz ; npm integrity
  `sha512-f/ZeWvW/BCXbhGEf1Ujp29EASo/lk1FDnETgNKwJrsVvGZhUWCZyg3xLJjAsxfOmt8KjswHmI5EwCQcPMpOYhQ==`.

**Historical mapping qualification:** the elkjs 0.9.3 tagged build reads an
external `../elk` checkout and references `0.10.0-SNAPSHOT`; its CI selects ELK
`master`. The historical external ELK commit/resolved build graph is not pinned
by that metadata. The Java repository and known source release above are real
retrieval locations, but an exact historical mapping or bit-for-bit reproduction
has not been established. The wrapper source archive alone is not all ELK Java
source. We do not claim that the illustrative Java release exactly corresponds
to every compiled class in the bundle.

## EMF-GWT 2.12.4 — EPL-1.0

The EMF contributors' source is available under EPL-1.0. Download these
versioned source archives (each retains its original contributor headers):

- `emf-common`:
  https://repo.maven.apache.org/maven2/com/genmymodel/emf/gwt/emf-common/2.12.4/emf-common-2.12.4-sources.jar
- `emf-ecore`:
  https://repo.maven.apache.org/maven2/com/genmymodel/emf/gwt/emf-ecore/2.12.4/emf-ecore-2.12.4-sources.jar

The version's parent POM declares EPL-1.0:
https://repo.maven.apache.org/maven2/com/genmymodel/emf/gwt/emf-parent/2.12.4/emf-parent-2.12.4.pom .
These are ZIP-format Java source archives; extract with an ordinary ZIP/JAR tool.

## Xbase and Xtend libraries 2.28.0 — EPL-2.0

The Xtext/Xtend contributors' source is available under EPL-2.0. Download and
extract the following ZIP-format Java source archives:

- https://repo.maven.apache.org/maven2/org/eclipse/xtext/org.eclipse.xtext.xbase.lib/2.28.0/org.eclipse.xtext.xbase.lib-2.28.0-sources.jar
- https://repo.maven.apache.org/maven2/org/eclipse/xtend/org.eclipse.xtend.lib/2.28.0/org.eclipse.xtend.lib-2.28.0-sources.jar

The EMF/Xbase/Xtend versions above are declared by the elkjs 0.9.3 tagged build
metadata and their component namespaces are identifiable in the bundle. They
are not a reconstruction of the historical publisher's entire resolved build.
The notice inventory preserves that distinction and archive/member provenance.
No EPL component was modified by this publication-readiness correction.
