const { getInput, info, setFailed, setOutput, getBooleanInput, debug, group } = require("@actions/core")
const fetch = require("node-fetch")

const getInputs = () => {
	try {
		const action = getInput("actionName", { required: true })
		const token = getInput("argocdToken", { required: true })
		const endpoint = getInput("argocdEndpoint", { required: true })
		const applicationName = getInput("applicationName", { required: true })

		//Helm values
		const helmRepoUrl = getInput("helmRepoUrl")
		const helmChartVersion = getInput("helmChartVersion")
		const helmChartName = getInput("helmChartName")

		//Application relatives values
		const applicationNamespace = getInput("applicationNamespace") || "default"
		const applicationProject = getInput("applicationProject")
		const applicationParams = getInput("applicationParams")

		// Others
		const maxRetry = getInput("maxRetry") || "5"
		const tts = getInput("tts") || "10"
		const destClusterName = getInput("destClusterName")
		const doSync = getBooleanInput("doSync")
		const onlySync = getBooleanInput("onlySync")

		if (
			(action == "create" || action == "update") &&
			(applicationParams == ""
				|| destClusterName == ""
				|| helmChartName == ""
				|| helmChartVersion == ""
				|| helmRepoUrl == "")
		) {
			throw new Error(`You must also provide (applicationParams, destClusterName, helmChartName, helmChartVersion, helmRepoUrl) inputs when using ${action} action`)
		}

		return {
			token,
			endpoint,
			destClusterName,
			applicationName,
			applicationNamespace,
			applicationProject,
			applicationParams,
			helmChartName,
			helmChartVersion,
			helmRepoUrl,
			doSync,
			onlySync,
			maxRetry,
			tts,
			action,
		}
	} catch (error) {
		setFailed(error.message)
	}
}

const generateOpts = (method = "", bearerToken = "", bodyObj) => {
	if (method == "delete" || method == "get") {
		return { method, headers: { "Authorization": `Bearer ${bearerToken}` } }
	} else if (bodyObj == null) {
		return { method, headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bearerToken}` } }
	}
	return { method, body: JSON.stringify(bodyObj), headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bearerToken}` }, }
}

const checkReady = (inputs = getInputs(), retry = inputs.maxRetry) => {
	return fetch.default(`${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`, generateOpts("get", inputs.token, null))
		.then(checkResponse)
		.then(r => r.json())
		.then(jsonResponse => {
			const status = jsonResponse.status.health.status
			info(`Application ${inputs.applicationName} has status ${status} (Left retries ${retry})`)
			if (status != "Healthy" && retry > 0) {
				setTimeout(() => {checkReady(inputs, retry - 1)}, inputs.tts * 1000)
			} else if (status != "Healthy" && retry == 0) {
				throw new Error(`[SYNC] ${inputs.applicationName} was unable to be fully synced after ${inputs.maxRetry} retries. Take a look at ${inputs.endpoint}/applications/${inputs.applicationName}`)
			}
		})
		.catch(err => setFailed(err))
}

const checkResponse = (response) => {
	info(`Response from ${response.url} [${response.status}] ${response.statusText}`)
	if (response.status >= 200 && response.status < 300) {
		return response;
	}
	throw new Error(`${response.url} ${response.statusText}`);
}

const syncApplication = (inputs = getInputs()) => {
	return fetch.default(`${inputs.endpoint}/api/v1/applications/${inputs.applicationName}/sync`, generateOpts("post", inputs.token, null))
		.then(checkResponse)
		.then(() => checkReady(inputs))
		.catch(err => setFailed(err.message))
}

const createApplication = (inputs = getInputs()) => {
	specs = generateSpecs(inputs)
	info(`[CREATE] Sending request to ${inputs.endpoint}/api/v1/applications`)
	return fetch.default(`${inputs.endpoint}/api/v1/applications`, generateOpts("post", inputs.token, specs))
		.then(checkResponse)
		.then(r => r.json())
		.then(jsonObj => setOutput("application", JSON.stringify(jsonObj)))
		.catch(err => setFailed(err))
}

const readApplication = (inputs = getInputs()) => {
	info(`[READ] Sending request to ${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`)
	return fetch.default(`${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`, generateOpts("get", inputs.token, null))
		.then(checkResponse)
		.then(r => r.json())
		.then(jsonObj => setOutput("application", JSON.stringify(jsonObj)))
		.catch(err => setFailed(err))
}

const updateApplication = (inputs = getInputs()) => {
	info(`[UPDATE] Sending request to ${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`)
	specs = generateSpecs(inputs)
	return fetch.default(`${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`, generateOpts("put", inputs.token, specs))
		.then(checkResponse)
		.catch(err => setFailed(err))
}

const deleteApplication = (inputs = getInputs()) => {
	info(`[DELETE] Sending request to ${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`)
	return fetch.default(`${inputs.endpoint}/api/v1/applications/${inputs.applicationName}`, generateOpts("delete", inputs.token, null))
		.then(checkResponse)
		.then(() => setOutput("application", JSON.stringify({ deleted: true })))
		.catch(err => setFailed(err))
}

const parseApplicationParams = (appParams = "") => {
	return appParams.split(";").map((v) => {
		const [name, value] = v.split("=", 2)
		return { name, value }
	})
}

const generateSpecs = (inputs = getInputs()) => {
	helmParameters = parseApplicationParams(inputs.applicationParams)
	return {
		metadata: {
			name: inputs.applicationName,
			namespace: "default"
		},
		spec: {
			source: {
				repoURL: inputs.helmRepoUrl,
				targetRevision: inputs.helmChartVersion,
				helm: {
					parameters: helmParameters
				},
				chart: inputs.helmChartName
			},
			destination: {
				name: inputs.destClusterName, namespace: inputs.applicationNamespace
			},
			project: inputs.applicationProject,
			syncPolicy: {}
		}
	}
}

const main = () => {
	inputs = getInputs()
	prom = null
	if (inputs.onlySync) {
		return syncApplication(inputs)
	}

	switch (inputs.action) {
		case "delete":
			return deleteApplication(inputs)
		case "get":
		case "read":
			return readApplication(inputs)
		case "create":
			prom = createApplication(inputs)
			break
		case "update":
			prom = updateApplication(inputs)
			break
		default:
			setFailed(new Error(`${inputs.action} does not exists in (create, get|read, update, delete)`))
			return
	}
	if (prom != null) {
		return prom.then(() => inputs.doSync ? syncApplication(inputs) : prom)
	}
}

main()