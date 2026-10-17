import Testing
@testable import SyloKit

@Test("SyloKit speaks app API version 1")
func apiVersion() {
    #expect(supportedAPIVersion == 1)
}
