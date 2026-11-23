"Pharo Agent live server.

Starts a small Zinc HTTP server, bound to 127.0.0.1 only, that lets the
pharo-agent CLI evaluate Smalltalk inside THIS running image. Changes the
agent makes (new classes, compiled methods, loaded packages) stay in the image,
exactly as if you had typed them in a Playground.

Load it into an image that is already open (Playground, select all, Do it):

    Smalltalk compiler evaluate: '/path/to/live-server.st' asFileReference contents.

or let the CLI start an image with it:

    pharo-agent live start

Every request must carry the random token that this script writes, together
with the port, to ~/.pharo-agent/live.json. The CLI reads that file.
The server is not saved with the image: run this script again after reopening
it (pharo-agent images start does it for you). Evaluate it again to restart
the server with a new token, or run

    (Smalltalk at: #PharoAgentLive) at: #stop

and evaluate the block it answers, to stop it.
This file is evaluated as a single chunk: it must not contain an exclamation mark."
| env port token state previous server respond display describe errorClasses isCompileProblem evaluate wait routes handler infoDir info log oneLine version imagePath |

env := [ :name |
	[ (Smalltalk at: #OSEnvironment) current at: name ifAbsent: [ nil ] ]
		on: Error do: [ :e | nil ] ].
port := ((env value: 'PHARO_AGENT_PORT')
	ifNil: [ (Smalltalk at: #PharoAgentLivePort ifAbsent: [ 4044 ]) printString ]) asNumber.
token := (env value: 'PHARO_AGENT_TOKEN') ifNil: [ UUID new asString ].
version := [ SystemVersion current version ] on: Error do: [ :e | 'Pharo' ].
imagePath := [ Smalltalk imagePath ] on: Error do: [ :e | '' ].

previous := Smalltalk at: #PharoAgentLive ifAbsent: [ nil ].
(previous isDictionary and: [ (previous at: #server ifAbsent: [ nil ]) notNil ])
	ifTrue: [
		"Stop it, and unregister it: an image saved by an older version of this
		script would otherwise have Zinc restart it with its stale token."
		[ (previous at: #server) stop ] on: Error do: [ :e | nil ].
		[ (previous at: #server) unregister ] on: Error do: [ :e | nil ] ].

state := Dictionary new.
state
	at: #token put: token;
	at: #port put: port;
	at: #log put: true;
	at: #requests put: 0.
Smalltalk at: #PharoAgentLive put: state.

oneLine := [ :text :max | | s |
	s := text asString collect: [ :c |
		(c = Character cr or: [ c = Character lf or: [ c = Character tab ] ])
			ifTrue: [ Character space ]
			ifFalse: [ c ] ].
	s size > max ifTrue: [ s := (s copyFrom: 1 to: max) , '...' ].
	s ].

log := [ :text |
	(state at: #log ifAbsent: [ false ]) ifTrue: [
		[ Transcript show: '[pharo-agent] ' , text; cr ] on: Error do: [ :e | nil ] ] ].

respond := [ :code :dict | | response |
	response := ZnResponse ok: (ZnEntity
		with: (STONJSON toString: dict)
		type: ZnMimeType applicationJson).
	response statusLine: (ZnStatusLine code: code).
	response ].

display := [ :value | | s |
	s := [ value displayString ]
		on: Error
		do: [ :e | [ value printString ] on: Error do: [ :e2 | '<unprintable>' ] ].
	s size > 50000 ifTrue: [ s := (s copyFrom: 1 to: 50000) , '... (truncated)' ].
	s ].

describe := [ :ex | | d ctx lines line n |
	d := Dictionary new.
	d
		at: 'ok' put: false;
		at: 'error' put: ([ ex description ] on: Error do: [ :e | ex class name asString ]);
		at: 'errorClass' put: ex class name asString.
	lines := OrderedCollection new.
	ctx := [ ex signalerContext ] on: Error do: [ :e | nil ].
	n := 0.
	[ ctx notNil and: [ n < 25 ] ] whileTrue: [
		line := [ ctx printString ] on: Error do: [ :e | '?' ].
		lines add: line.
		(line includesSubstring: 'DoIt')
			ifTrue: [ ctx := nil ]
			ifFalse: [ ctx := ctx sender ].
		n := n + 1 ].
	d at: 'stack' put: lines asArray.
	d ].

"Compile problems are Errors in recent Pharo, but Notifications/Warnings in older ones."
errorClasses := Error.
#( #SyntaxErrorNotification #OCSemanticWarning #AuthorNameRequest ) do: [ :name |
	Smalltalk at: name ifPresent: [ :cls | errorClasses := errorClasses , cls ] ].
isCompileProblem := [ :ex |
	(ex isKindOf: Error) or: [
		#( #SyntaxErrorNotification #OCSemanticWarning ) anySatisfy: [ :name |
			(Smalltalk at: name ifAbsent: [ nil ])
				ifNil: [ false ]
				ifNotNil: [ :cls | ex isKindOf: cls ] ] ] ].

wait := [ :semaphore :ms |
	(semaphore respondsTo: #waitTimeoutMilliseconds:)
		ifTrue: [ semaphore waitTimeoutMilliseconds: ms ]
		ifFalse: [ semaphore waitTimeoutMSecs: ms ] ].

evaluate := [ :code :timeoutMs :ui | | semaphore outcome process warnings started work timedOut |
	warnings := OrderedCollection new.
	semaphore := Semaphore new.
	started := Time millisecondClockValue.
	work := [
		outcome := [ | value d |
			value := Smalltalk compiler evaluate: code.
			d := Dictionary new.
			d
				at: 'ok' put: true;
				at: 'result' put: (display value: value);
				at: 'resultClass' put: value class name asString.
			d ]
				on: errorClasses , Warning
				do: [ :ex |
					"Older images ask for author initials before compiling."
					ex class name = #AuthorNameRequest
						ifTrue: [ ex resume: 'PharoAgent' ]
						ifFalse: [
							(isCompileProblem value: ex)
								ifTrue: [ describe value: ex ]
								ifFalse: [
									warnings add: ex class name asString , ': ' , ([ ex messageText asString ] on: Error do: [ :e | '' ]).
									ex resume ] ] ].
		semaphore signal ].
	ui
		ifTrue: [ UIManager default defer: work ]
		ifFalse: [ process := work forkAt: Processor userSchedulingPriority named: 'pharo-agent eval' ].
	timedOut := wait value: semaphore value: timeoutMs.
	timedOut ifTrue: [
		process ifNotNil: [ process terminate ].
		outcome := Dictionary new.
		outcome
			at: 'ok' put: false;
			at: 'error' put: 'Timed out after ' , timeoutMs printString , ' ms (evaluation was terminated)';
			at: 'errorClass' put: 'Timeout';
			at: 'stack' put: #() ].
	outcome at: 'durationMs' put: Time millisecondClockValue - started.
	outcome at: 'warnings' put: warnings asArray.
	outcome ].

routes := Dictionary new.
routes at: '/health' put: [ :json |
	Dictionary new
		at: 'ok' put: true;
		at: 'service' put: 'pharo-agent-live';
		at: 'protocol' put: 1;
		at: 'pharo' put: version;
		at: 'image' put: imagePath;
		at: 'port' put: port;
		at: 'requests' put: (state at: #requests);
		yourself ].
routes at: '/eval' put: [ :json | | code result |
	code := (json at: 'code' ifAbsent: [ '' ]) asString.
	log value: (oneLine value: code value: 160).
	result := evaluate
		value: code
		value: (json at: 'timeoutMs' ifAbsent: [ 60000 ])
		value: (json at: 'ui' ifAbsent: [ false ]) == true.
	log value: '  => ' , (oneLine value: ((result at: 'ok')
		ifTrue: [ result at: 'result' ]
		ifFalse: [ result at: 'error' ]) value: 160).
	result ].
routes at: '/save' put: [ :json |
	log value: 'saving image'.
	"Snapshot outside the HTTP worker so the response still goes out."
	[ Smalltalk snapshot: true andQuit: false ] forkAt: Processor userBackgroundPriority named: 'pharo-agent save'.
	Dictionary new
		at: 'ok' put: true;
		at: 'scheduled' put: true;
		at: 'image' put: imagePath;
		yourself ].

handler := [ :request | | path route body json |
	state at: #requests put: (state at: #requests) + 1.
	path := request uri pathPrintString.
	route := routes at: path ifAbsent: [ nil ].
	(request headers at: 'X-Pharo-Agent-Token' ifAbsent: [ nil ]) = token
		ifFalse: [ respond value: 401 value: (Dictionary new
			at: 'ok' put: false;
			at: 'error' put: 'Missing or invalid X-Pharo-Agent-Token';
			yourself) ]
		ifTrue: [
			route
				ifNil: [ respond value: 404 value: (Dictionary new
					at: 'ok' put: false;
					at: 'error' put: 'Unknown endpoint ' , path;
					yourself) ]
				ifNotNil: [
					body := request entity ifNil: [ '{}' ] ifNotNil: [ :entity | entity contents ].
					(body isKindOf: ByteArray) ifTrue: [ body := body utf8Decoded ].
					body isString ifFalse: [ body := '' ].
					json := [ STONJSON fromString: body ] on: Error do: [ :e | nil ].
					(json isNil and: [ request method = #POST ])
						ifTrue: [ respond value: 400 value: (Dictionary new
							at: 'ok' put: false;
							at: 'error' put: 'Send a JSON body with content-type application/json';
							yourself) ]
						ifFalse: [
							json isDictionary ifFalse: [ json := Dictionary new ].
							respond value: 200 value: (route value: json) ] ] ] ].

server := ZnServer on: port.
server bindingAddress: #[127 0 0 1].
server delegate: (ZnValueDelegate with: handler).
server start.
"Deliberately not registered with Zinc: a saved image must not reopen with an
old server and token. pharo-agent starts images with a fresh one."
state at: #server put: server.
state at: #stop put: [
	server stop.
	log value: 'live server stopped' ].

infoDir := FileLocator home / '.pharo-agent'.
infoDir ensureCreateDirectory.
info := Dictionary new.
info
	at: 'url' put: 'http://127.0.0.1:' , port printString;
	at: 'port' put: port;
	at: 'token' put: token;
	at: 'pharo' put: version;
	at: 'image' put: imagePath;
	at: 'startedAt' put: DateAndTime now printString.
info at: 'pid' put: ([ (Smalltalk at: #OSPlatform) current currentProcessId ] on: Error do: [ :e | nil ]).
"One file per running server, so several images can be live at once; live.json is the latest."
(infoDir / 'endpoints') ensureCreateDirectory.
{ infoDir / 'endpoints' / (port printString , '.json'). infoDir / 'live.json' } do: [ :file |
	file ensureDelete.
	file writeStreamDo: [ :stream | stream nextPutAll: (STONJSON toString: info) ] ].

log value: 'live server listening on http://127.0.0.1:' , port printString , ' (token in ~/.pharo-agent/live.json)'.
state
