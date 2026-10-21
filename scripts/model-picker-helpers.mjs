// Drive the same provider -> model -> effort path a reader uses.
export async function chooseModel(
  page,
  providers,
  providerId,
  modelId,
  effort = "",
  scope = page,
) {
  const provider = providers.find((p) => p.id === providerId),
    model = provider?.models.find((m) => m.id === modelId);
  if (!model) throw new Error(`Missing fixture model ${providerId}/${modelId}`);
  await scope
    .getByRole("button", { name: "Agent and model", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: provider.name, exact: true })
    .click();
  await page
    .getByRole(model.efforts?.length ? "menuitem" : "menuitemradio", {
      name: model.name,
      exact: true,
    })
    .click();
  if (model.efforts?.length) {
    if (!effort) throw new Error(`An effort is required for ${modelId}`);
    await page
      .getByRole("menuitemradio", {
        name: effort[0].toUpperCase() + effort.slice(1),
        exact: true,
      })
      .click();
  }
}
