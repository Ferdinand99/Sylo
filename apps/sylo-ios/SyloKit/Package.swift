// swift-tools-version: 6.0
// SyloKit: everything in the Sylo app that is not UI (API client, models, sign-in helpers,
// token storage). A package so it can be built and tested with `swift test` on its own, on macOS
// in CI and on any machine with a Swift toolchain, without the Xcode project.
import PackageDescription

let package = Package(
    name: "SyloKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SyloKit", targets: ["SyloKit"]),
    ],
    targets: [
        .target(name: "SyloKit"),
        .testTarget(name: "SyloKitTests", dependencies: ["SyloKit"]),
    ]
)
