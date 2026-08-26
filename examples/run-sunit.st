| testCaseClass testResultClass suite result |
testCaseClass := Smalltalk at: #TestCase ifAbsent: [ self error: 'TestCase not found' ].
testResultClass := Smalltalk at: #TestResult ifAbsent: [ self error: 'TestResult not found' ].
suite := testCaseClass suite.
result := testResultClass new.
suite run: result.
Stdio stdout
  nextPutAll: 'runs: '; nextPutAll: result runCount asString; cr;
  nextPutAll: 'failures: '; nextPutAll: result failures size asString; cr;
  nextPutAll: 'errors: '; nextPutAll: result errors size asString; cr.
Smalltalk snapshot: false andQuit: true.
