# Роуты плагина Redmine Work Scheme
get '/work_scheme', to: 'work_scheme#show', as: :work_scheme
get '/work_scheme/counts', to: 'work_scheme#counts', as: :work_scheme_counts
# Страницы этапов дополнительных схем (коллекция); легаси-ссылки без
# scheme_id ведут на первую схему коллекции.
get '/work_scheme/stages/:scheme_id/:id', to: 'work_scheme#stage', as: :work_scheme_scheme_stage
get '/work_scheme/stages/:id', to: 'work_scheme#stage', as: :work_scheme_stage
get '/work_scheme/edit', to: 'work_scheme#edit', as: :work_scheme_edit
post '/work_scheme/save', to: 'work_scheme#save', as: :work_scheme_save
